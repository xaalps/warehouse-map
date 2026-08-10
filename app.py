"""
仓内地图数据采集程序 - 后端服务
Flask + SQLite + Dijkstra 全源最短路径
"""
import os
import sqlite3
import json
import math
import heapq
import csv
import io
from datetime import datetime

from flask import Flask, render_template, request, jsonify, Response, send_file

app = Flask(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, 'data', 'warehouse.db')

# ---------- 数据库 ----------

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = get_db()
    c = conn.cursor()

    # 点位类型表（支持自定义类型）
    c.execute("""
        CREATE TABLE IF NOT EXISTS point_types (
            key    TEXT PRIMARY KEY,
            label  TEXT NOT NULL,
            color  TEXT NOT NULL,
            icon   TEXT NOT NULL,
            sort   INTEGER DEFAULT 0
        )
    """)
    # 默认点位类型
    default_types = [
        ('start', '出发点', '#3ecf8e', 'S', 0),
        ('end', '终止点', '#ef5b5b', 'E', 1),
        ('pickup', '取货点', '#5b8def', 'P', 2),
        ('intersection', '岔路点', '#f0a93b', 'X', 3),
    ]
    for key, label, color, icon, sort in default_types:
        c.execute("INSERT OR IGNORE INTO point_types(key, label, color, icon, sort) VALUES(?,?,?,?,?)",
                  (key, label, color, icon, sort))

    # 迁移：如果 points 表有 CHECK 约束，移除以支持自定义类型
    table_sql = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='points'").fetchone()
    if table_sql and 'CHECK' in table_sql['sql']:
        c.execute("""CREATE TABLE points_new (
            id    TEXT PRIMARY KEY,
            x     REAL NOT NULL,
            y     REAL NOT NULL,
            type  TEXT NOT NULL
        )""")
        c.execute("INSERT INTO points_new(id, x, y, type) SELECT id, x, y, type FROM points")
        c.execute("DROP TABLE points")
        c.execute("ALTER TABLE points_new RENAME TO points")

    c.execute("""
        CREATE TABLE IF NOT EXISTS points (
            id    TEXT PRIMARY KEY,
            x     REAL NOT NULL,
            y     REAL NOT NULL,
            type  TEXT NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS lines (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            start_point_id  TEXT NOT NULL,
            end_point_id    TEXT NOT NULL,
            distance        REAL NOT NULL,
            travel_time     REAL NOT NULL,
            FOREIGN KEY (start_point_id) REFERENCES points(id),
            FOREIGN KEY (end_point_id)   REFERENCES points(id)
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS paths (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            start_point_id  TEXT NOT NULL,
            end_point_id    TEXT NOT NULL,
            distance        REAL NOT NULL,
            travel_time     REAL NOT NULL,
            route           TEXT,
            generated_at    TEXT
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT
        )
    """)

    # 默认步行速度 1.2 m/s
    c.execute("INSERT OR IGNORE INTO settings(key, value) VALUES('walk_speed', '1.2')")
    # 默认坐标比例：1 像素 = 0.1 米
    c.execute("INSERT OR IGNORE INTO settings(key, value) VALUES('scale', '0.1')")
    # 默认点位ID数字部分长度（6位 → P000001）
    c.execute("INSERT OR IGNORE INTO settings(key, value) VALUES('id_length', '6')")

    # 索引
    c.execute("CREATE INDEX IF NOT EXISTS idx_lines_start ON lines(start_point_id)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_lines_end ON lines(end_point_id)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_paths_start ON paths(start_point_id)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_paths_end ON paths(end_point_id)")

    conn.commit()
    conn.close()


# ---------- 辅助函数 ----------

def get_setting(key, default=None):
    conn = get_db()
    row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    conn.close()
    return row['value'] if row else default


def set_setting(key, value):
    conn = get_db()
    conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES(?,?)", (key, str(value)))
    conn.commit()
    conn.close()


def calc_distance(x1, y1, x2, y2):
    """欧氏距离（像素单位）"""
    return math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)


def calc_travel_time(distance, scale, walk_speed):
    """
    通行耗时 = (像素距离 × 比例尺) / 步行速度  → 秒
    scale: 像素→米 的换算系数
    walk_speed: 米/秒
    """
    meters = distance * scale
    return round(meters / walk_speed, 2) if walk_speed > 0 else 0


def point_type_label(t):
    conn = get_db()
    row = conn.execute("SELECT label FROM point_types WHERE key=?", (t,)).fetchone()
    conn.close()
    return row['label'] if row else t


def get_point_types_dict():
    """从数据库获取所有点位类型配置"""
    conn = get_db()
    rows = conn.execute("SELECT * FROM point_types ORDER BY sort").fetchall()
    conn.close()
    return {r['key']: dict(r) for r in rows}


def is_valid_point_type(ptype):
    """检查点位类型是否存在于 point_types 表"""
    conn = get_db()
    row = conn.execute("SELECT 1 FROM point_types WHERE key=?", (ptype,)).fetchone()
    conn.close()
    return row is not None


def invalidate_paths(conn):
    """清除过期路径数据（点位/动线变更后路径距离不再有效）"""
    conn.execute("DELETE FROM paths")
    set_setting_conn(conn, 'paths_stale', '1')


def set_setting_conn(conn, key, value):
    """在已有连接上写入设置（不开新连接）"""
    conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES(?,?)", (key, str(value)))


def recalculate_travel_times():
    """
    当 scale 或 walk_speed 变更后，重新计算所有动线和路径的通行耗时。
    distance（像素）保持不变，仅更新 travel_time。
    """
    walk_speed = float(get_setting('walk_speed', '1.2'))
    scale = float(get_setting('scale', '0.1'))
    conn = get_db()
    # 更新动线耗时
    for ln in conn.execute("SELECT id, distance FROM lines").fetchall():
        tt = calc_travel_time(ln['distance'], scale, walk_speed)
        conn.execute("UPDATE lines SET travel_time=? WHERE id=?", (tt, ln['id']))
    # 更新路径耗时
    for p in conn.execute("SELECT id, distance FROM paths WHERE distance >= 0").fetchall():
        tt = calc_travel_time(p['distance'], scale, walk_speed)
        conn.execute("UPDATE paths SET travel_time=? WHERE id=?", (tt, p['id']))
    conn.commit()
    conn.close()


# ---------- 路径算法 ----------

def build_adjacency():
    """根据动线构建邻接表（双向图）"""
    conn = get_db()
    lines = conn.execute("SELECT * FROM lines").fetchall()
    points = conn.execute("SELECT * FROM points").fetchall()
    conn.close()

    adj = {p['id']: [] for p in points}
    for ln in lines:
        dist = ln['distance']
        ttime = ln['travel_time']
        adj.setdefault(ln['start_point_id'], []).append((ln['end_point_id'], dist, ttime))
        adj.setdefault(ln['end_point_id'], []).append((ln['start_point_id'], dist, ttime))
    return adj


def dijkstra_single(adj, source):
    """单源 Dijkstra，返回 dist dict 和 predecessor dict"""
    dist = {}
    prev = {}
    dist[source] = 0
    pq = [(0, source)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, float('inf')):
            continue
        for v, w, _ in adj.get(u, []):
            nd = d + w
            if nd < dist.get(v, float('inf')):
                dist[v] = nd
                prev[v] = u
                heapq.heappush(pq, (nd, v))
    return dist, prev


def reconstruct_route(prev, source, target):
    """从 predecessor 表回溯路径"""
    if target not in prev and target != source:
        return []
    route = [target]
    cur = target
    while cur != source:
        cur = prev.get(cur)
        if cur is None:
            return []
        route.append(cur)
    route.reverse()
    return route


def generate_all_pairs():
    """
    全源最短路径：对每个点运行 Dijkstra，
    生成 N*N 路径数据并写入 paths 表
    """
    conn = get_db()
    points = [r['id'] for r in conn.execute("SELECT id FROM points").fetchall()]
    lines = conn.execute("SELECT * FROM lines").fetchall()
    walk_speed = float(get_setting('walk_speed', '1.2'))
    scale = float(get_setting('scale', '0.1'))
    conn.close()

    if not points:
        return {"error": "没有点位数据"}, 400
    if not lines:
        return {"error": "没有动线数据，无法计算路径"}, 400

    adj = build_adjacency()
    now = datetime.now().isoformat()

    conn = get_db()
    conn.execute("DELETE FROM paths")
    batch = []
    count = 0
    for src in points:
        dist_map, prev_map = dijkstra_single(adj, src)
        for dst in points:
            if src == dst:
                distance = 0.0
                route = json.dumps([src])
            else:
                distance = dist_map.get(dst)
                if distance is None:
                    # 不可达
                    distance = -1
                    route = json.dumps([])
                else:
                    route_list = reconstruct_route(prev_map, src, dst)
                    route = json.dumps(route_list)
            travel_time = calc_travel_time(distance, scale, walk_speed) if distance >= 0 else -1
            batch.append((src, dst, round(distance, 2), travel_time, route, now))
            count += 1
        # 每 5000 条批量写入
        if len(batch) >= 5000:
            conn.executemany(
                "INSERT INTO paths(start_point_id, end_point_id, distance, travel_time, route, generated_at) VALUES(?,?,?,?,?,?)",
                batch
            )
            conn.commit()
            batch = []
    if batch:
        conn.executemany(
            "INSERT INTO paths(start_point_id, end_point_id, distance, travel_time, route, generated_at) VALUES(?,?,?,?,?,?)",
            batch
        )
        conn.commit()
    # 路径已重新生成，清除过期标记
    set_setting_conn(conn, 'paths_stale', '0')
    conn.commit()
    conn.close()
    return {"total": count, "point_count": len(points)}, 200


# ---------- API: 点位 ----------

@app.route('/api/points', methods=['GET'])
def get_points():
    conn = get_db()
    rows = conn.execute("SELECT * FROM points ORDER BY id").fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route('/api/points', methods=['POST'])
def add_point():
    data = request.json
    pid = data.get('id', '').strip()
    if not pid:
        return jsonify({"error": "点位 ID 不能为空"}), 400
    x = float(data['x'])
    y = float(data['y'])
    ptype = data.get('type', 'intersection')
    if not is_valid_point_type(ptype):
        return jsonify({"error": f"无效的点位类型: {ptype}"}), 400
    conn = get_db()
    try:
        conn.execute("INSERT INTO points(id, x, y, type) VALUES(?,?,?,?)", (pid, x, y, ptype))
        invalidate_paths(conn)
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        return jsonify({"error": f"点位 ID '{pid}' 已存在"}), 409
    conn.close()
    return jsonify({"id": pid, "x": x, "y": y, "type": ptype}), 201


@app.route('/api/points/<pid>', methods=['PUT'])
def update_point(pid):
    data = request.json
    conn = get_db()
    row = conn.execute("SELECT * FROM points WHERE id=?", (pid,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "点位不存在"}), 404
    new_id = data.get('new_id', pid).strip()
    x = float(data.get('x', row['x']))
    y = float(data.get('y', row['y']))
    ptype = data.get('type', row['type'])
    if not is_valid_point_type(ptype):
        conn.close()
        return jsonify({"error": f"无效的点位类型: {ptype}"}), 400

    id_changed = new_id != pid
    if id_changed:
        # 检查新ID是否已存在
        if conn.execute("SELECT 1 FROM points WHERE id=?", (new_id,)).fetchone():
            conn.close()
            return jsonify({"error": f"点位 ID '{new_id}' 已存在"}), 409
        # 更新点位ID
        conn.execute("UPDATE points SET id=?, x=?, y=?, type=? WHERE id=?", (new_id, x, y, ptype, pid))
        # 级联更新动线
        conn.execute("UPDATE lines SET start_point_id=? WHERE start_point_id=?", (new_id, pid))
        conn.execute("UPDATE lines SET end_point_id=? WHERE end_point_id=?", (new_id, pid))
        # 级联更新路径（start/end 字段 + route JSON）
        conn.execute("UPDATE paths SET start_point_id=? WHERE start_point_id=?", (new_id, pid))
        conn.execute("UPDATE paths SET end_point_id=? WHERE end_point_id=?", (new_id, pid))
        # 更新 route JSON 中的点位引用
        like_pattern = f'%"{pid}"%'
        for p in conn.execute("SELECT id, route FROM paths WHERE route LIKE ?", (like_pattern,)).fetchall():
            if p['route']:
                route = json.loads(p['route'])
                if pid in route:
                    new_route = [new_id if r == pid else r for r in route]
                    conn.execute("UPDATE paths SET route=? WHERE id=?", (json.dumps(new_route), p['id']))
    else:
        conn.execute("UPDATE points SET x=?, y=?, type=? WHERE id=?", (x, y, ptype, pid))

    # 更新关联动线的距离和耗时
    walk_speed = float(get_setting('walk_speed', '1.2'))
    scale = float(get_setting('scale', '0.1'))
    lines = conn.execute("SELECT * FROM lines WHERE start_point_id=? OR end_point_id=?", (new_id, new_id)).fetchall()
    point_cache = {r['id']: (r['x'], r['y']) for r in conn.execute("SELECT * FROM points").fetchall()}
    for ln in lines:
        sp = point_cache.get(ln['start_point_id'])
        ep = point_cache.get(ln['end_point_id'])
        if sp and ep:
            dist = calc_distance(sp[0], sp[1], ep[0], ep[1])
            tt = calc_travel_time(dist, scale, walk_speed)
            conn.execute("UPDATE lines SET distance=?, travel_time=? WHERE id=?", (round(dist, 2), tt, ln['id']))
    # 坐标变更 → 路径数据失效
    invalidate_paths(conn)
    conn.commit()
    conn.close()
    return jsonify({"id": new_id, "x": x, "y": y, "type": ptype, "id_changed": id_changed})


@app.route('/api/points/<pid>', methods=['DELETE'])
def delete_point(pid):
    conn = get_db()
    # 删除关联动线
    conn.execute("DELETE FROM lines WHERE start_point_id=? OR end_point_id=?", (pid, pid))
    conn.execute("DELETE FROM points WHERE id=?", (pid,))
    invalidate_paths(conn)
    conn.commit()
    conn.close()
    return jsonify({"deleted": pid})


@app.route('/api/points/batch', methods=['POST'])
def batch_add_points():
    """批量导入点位"""
    data = request.json
    items = data.get('points', [])
    conn = get_db()
    added, skipped = 0, 0
    for item in items:
        try:
            conn.execute("INSERT INTO points(id, x, y, type) VALUES(?,?,?,?)",
                         (item['id'], float(item['x']), float(item['y']), item.get('type', 'intersection')))
            added += 1
        except sqlite3.IntegrityError:
            skipped += 1
    if added > 0:
        invalidate_paths(conn)
    conn.commit()
    conn.close()
    return jsonify({"added": added, "skipped": skipped})


# ---------- API: 动线 ----------

@app.route('/api/lines', methods=['GET'])
def get_lines():
    conn = get_db()
    rows = conn.execute("SELECT * FROM lines ORDER BY id").fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route('/api/lines', methods=['POST'])
def add_line():
    data = request.json
    sp = data.get('start_point_id', '').strip()
    ep = data.get('end_point_id', '').strip()
    if sp == ep:
        return jsonify({"error": "起点和终点不能相同"}), 400
    conn = get_db()
    # 验证点位存在
    for pid in (sp, ep):
        if not conn.execute("SELECT 1 FROM points WHERE id=?", (pid,)).fetchone():
            conn.close()
            return jsonify({"error": f"点位 '{pid}' 不存在"}), 400
    walk_speed = float(get_setting('walk_speed', '1.2'))
    scale = float(get_setting('scale', '0.1'))
    sp_row = conn.execute("SELECT * FROM points WHERE id=?", (sp,)).fetchone()
    ep_row = conn.execute("SELECT * FROM points WHERE id=?", (ep,)).fetchone()
    if data.get('distance') is not None:
        dist = float(data['distance'])
    else:
        dist = calc_distance(sp_row['x'], sp_row['y'], ep_row['x'], ep_row['y'])
    tt = calc_travel_time(dist, scale, walk_speed)
    cur = conn.execute(
        "INSERT INTO lines(start_point_id, end_point_id, distance, travel_time) VALUES(?,?,?,?)",
        (sp, ep, round(dist, 2), tt)
    )
    invalidate_paths(conn)
    conn.commit()
    lid = cur.lastrowid
    conn.close()
    return jsonify({"id": lid, "start_point_id": sp, "end_point_id": ep,
                    "distance": round(dist, 2), "travel_time": tt}), 201


@app.route('/api/lines/<int:lid>', methods=['DELETE'])
def delete_line(lid):
    conn = get_db()
    conn.execute("DELETE FROM lines WHERE id=?", (lid,))
    invalidate_paths(conn)
    conn.commit()
    conn.close()
    return jsonify({"deleted": lid})


@app.route('/api/lines/batch', methods=['POST'])
def batch_add_lines():
    """批量导入动线"""
    data = request.json
    items = data.get('lines', [])
    conn = get_db()
    walk_speed = float(get_setting('walk_speed', '1.2'))
    scale = float(get_setting('scale', '0.1'))
    point_cache = {r['id']: (r['x'], r['y']) for r in conn.execute("SELECT * FROM points").fetchall()}
    added, skipped = 0, 0
    for item in items:
        sp = item.get('start_point_id', '').strip()
        ep = item.get('end_point_id', '').strip()
        if sp == ep or sp not in point_cache or ep not in point_cache:
            skipped += 1
            continue
        if item.get('distance') is not None:
            dist = float(item['distance'])
        else:
            sx, sy = point_cache[sp]
            ex, ey = point_cache[ep]
            dist = calc_distance(sx, sy, ex, ey)
        tt = calc_travel_time(dist, scale, walk_speed)
        try:
            conn.execute(
                "INSERT INTO lines(start_point_id, end_point_id, distance, travel_time) VALUES(?,?,?,?)",
                (sp, ep, round(dist, 2), tt)
            )
            added += 1
        except Exception:
            skipped += 1
    if added > 0:
        invalidate_paths(conn)
    conn.commit()
    conn.close()
    return jsonify({"added": added, "skipped": skipped})


# ---------- API: 通道批量生成 ----------

@app.route('/api/aisle/generate', methods=['POST'])
def generate_aisle():
    """
    通道批量生成：指定通道起止点和货位数量，自动生成所有货位点数据及连线。
    
    请求参数:
      start_id:     起点ID（如已存在则复用，不存在则创建）
      start_x:      起点X坐标
      start_y:      起点Y坐标
      start_type:   起点类型（默认 intersection）
      end_id:       终点ID
      end_x:        终点X坐标
      end_y:        终点Y坐标
      end_type:     终点类型（默认 intersection）
      count:        货位数量
      prefix:       货位ID前缀（如 "A" → A1, A2, ...）
      pickup_type:  货位类型（默认 pickup）
      auto_connect: 是否自动创建动线（默认 true）
    """
    data = request.json
    start_id = data.get('start_id', '').strip()
    end_id = data.get('end_id', '').strip()
    
    if not start_id or not end_id:
        return jsonify({"error": "起点ID和终点ID不能为空"}), 400
    if start_id == end_id:
        return jsonify({"error": "起点和终点不能相同"}), 400
    
    count = int(data.get('count', 0))
    if count < 1:
        return jsonify({"error": "货位数量至少为1"}), 400
    if count > 500:
        return jsonify({"error": "单次生成货位数量不能超过500"}), 400
    
    prefix = data.get('prefix', 'P').strip()
    start_x = float(data['start_x'])
    start_y = float(data['start_y'])
    end_x = float(data['end_x'])
    end_y = float(data['end_y'])
    start_type = data.get('start_type', 'intersection')
    end_type = data.get('end_type', 'intersection')
    pickup_type = data.get('pickup_type', 'pickup')
    auto_connect = data.get('auto_connect', True)

    # 校验点位类型有效性
    if not is_valid_point_type(pickup_type):
        return jsonify({"error": f"货位类型 '{pickup_type}' 不存在，请先在点位类型管理中添加"}), 400
    if not is_valid_point_type(start_type):
        return jsonify({"error": f"起点类型 '{start_type}' 不存在"}), 400
    if not is_valid_point_type(end_type):
        return jsonify({"error": f"终点类型 '{end_type}' 不存在"}), 400
    
    walk_speed = float(get_setting('walk_speed', '1.2'))
    scale = float(get_setting('scale', '0.1'))
    id_length = int(get_setting('id_length', '6'))

    conn = get_db()
    created_points = []
    created_lines = []
    skipped = 0
    
    # --- 创建/复用起点 ---
    existing = conn.execute("SELECT * FROM points WHERE id=?", (start_id,)).fetchone()
    if existing:
        start_x, start_y = existing['x'], existing['y']
        start_type = existing['type']
    else:
        try:
            conn.execute("INSERT INTO points(id, x, y, type) VALUES(?,?,?,?)",
                         (start_id, start_x, start_y, start_type))
            created_points.append({"id": start_id, "x": start_x, "y": start_y, "type": start_type})
        except sqlite3.IntegrityError:
            skipped += 1
    
    # --- 创建/复用终点 ---
    existing = conn.execute("SELECT * FROM points WHERE id=?", (end_id,)).fetchone()
    if existing:
        end_x, end_y = existing['x'], existing['y']
        end_type = existing['type']
    else:
        try:
            conn.execute("INSERT INTO points(id, x, y, type) VALUES(?,?,?,?)",
                         (end_id, end_x, end_y, end_type))
            created_points.append({"id": end_id, "x": end_x, "y": end_y, "type": end_type})
        except sqlite3.IntegrityError:
            skipped += 1
    
    # --- 生成货位点（均匀分布在起点和终点之间）---
    pickup_ids = []
    for i in range(1, count + 1):
        pid = f"{prefix}{str(i).zfill(id_length)}"
        # 均匀分布：i/(count+1) 使得起点和终点在两端
        t = i / (count + 1)
        px = round(start_x + (end_x - start_x) * t, 1)
        py = round(start_y + (end_y - start_y) * t, 1)
        try:
            conn.execute("INSERT INTO points(id, x, y, type) VALUES(?,?,?,?)",
                         (pid, px, py, pickup_type))
            created_points.append({"id": pid, "x": px, "y": py, "type": pickup_type})
            pickup_ids.append(pid)
        except sqlite3.IntegrityError:
            # ID已存在，跳过
            skipped += 1
            # 仍然加入序列以便连线
            pickup_ids.append(pid)
    
    # --- 自动创建动线 ---
    if auto_connect and pickup_ids:
        # 构建序列：起点 → P1 → P2 → ... → PN → 终点
        sequence = [start_id] + pickup_ids + [end_id]
        point_cache = {r['id']: (r['x'], r['y']) for r in conn.execute("SELECT * FROM points").fetchall()}
        
        for j in range(len(sequence) - 1):
            sp_id = sequence[j]
            ep_id = sequence[j + 1]
            if sp_id not in point_cache or ep_id not in point_cache:
                continue
            # 检查是否已存在（双向）
            exists = conn.execute(
                "SELECT 1 FROM lines WHERE (start_point_id=? AND end_point_id=?) OR (start_point_id=? AND end_point_id=?)",
                (sp_id, ep_id, ep_id, sp_id)
            ).fetchone()
            if exists:
                continue
            sx, sy = point_cache[sp_id]
            ex, ey = point_cache[ep_id]
            dist = calc_distance(sx, sy, ex, ey)
            tt = calc_travel_time(dist, scale, walk_speed)
            cur = conn.execute(
                "INSERT INTO lines(start_point_id, end_point_id, distance, travel_time) VALUES(?,?,?,?)",
                (sp_id, ep_id, round(dist, 2), tt)
            )
            created_lines.append({
                "id": cur.lastrowid,
                "start_point_id": sp_id,
                "end_point_id": ep_id,
                "distance": round(dist, 2),
                "travel_time": tt
            })
    
    if created_points or created_lines:
        invalidate_paths(conn)
    conn.commit()
    conn.close()
    
    return jsonify({
        "created_points": created_points,
        "created_lines": created_lines,
        "point_count": len(created_points),
        "line_count": len(created_lines),
        "skipped": skipped,
        "sequence": [start_id] + pickup_ids + [end_id]
    }), 201


# ---------- API: 路径生成 ----------

@app.route('/api/paths/generate', methods=['POST'])
def generate_paths():
    result, code = generate_all_pairs()
    return jsonify(result), code


@app.route('/api/paths', methods=['GET'])
def get_paths():
    page = int(request.args.get('page', 1))
    per_page = min(int(request.args.get('per_page', 50)), 500)
    search = request.args.get('search', '').strip()
    offset = (page - 1) * per_page

    conn = get_db()
    query = "SELECT * FROM paths"
    count_query = "SELECT COUNT(*) as cnt FROM paths"
    params = []
    if search:
        query += " WHERE start_point_id LIKE ? OR end_point_id LIKE ?"
        count_query += " WHERE start_point_id LIKE ? OR end_point_id LIKE ?"
        params = [f"%{search}%", f"%{search}%"]
    total = conn.execute(count_query, params).fetchone()['cnt']
    rows = conn.execute(query + " ORDER BY id LIMIT ? OFFSET ?", params + [per_page, offset]).fetchall()
    conn.close()
    return jsonify({
        "data": [dict(r) for r in rows],
        "total": total,
        "page": page,
        "per_page": per_page
    })


@app.route('/api/paths/stats', methods=['GET'])
def path_stats():
    scale = float(get_setting('scale', '0.1'))
    conn = get_db()
    total = conn.execute("SELECT COUNT(*) as cnt FROM paths").fetchone()['cnt']
    reachable = conn.execute("SELECT COUNT(*) as cnt FROM paths WHERE distance >= 0").fetchone()['cnt']
    unreachable = conn.execute("SELECT COUNT(*) as cnt FROM paths WHERE distance < 0").fetchone()['cnt']
    avg_dist = conn.execute("SELECT AVG(distance) as avg FROM paths WHERE distance > 0").fetchone()['avg']
    max_dist = conn.execute("SELECT MAX(distance) as max FROM paths WHERE distance > 0").fetchone()['max']
    paths_stale = get_setting('paths_stale', '0')
    conn.close()
    return jsonify({
        "total": total,
        "reachable": reachable,
        "unreachable": unreachable,
        "avg_distance": round(avg_dist * scale * 1000, 1) if avg_dist else 0,
        "max_distance": round(max_dist * scale * 1000, 1) if max_dist else 0,
        "stale": paths_stale == '1',
    })


# ---------- API: 设置 ----------

@app.route('/api/settings', methods=['GET'])
def get_settings():
    conn = get_db()
    rows = conn.execute("SELECT * FROM settings").fetchall()
    conn.close()
    return jsonify({r['key']: r['value'] for r in rows})


@app.route('/api/settings', methods=['POST'])
def update_settings():
    data = request.json
    # 记录旧值，判断是否需要重算
    old_scale = get_setting('scale', '0.1')
    old_speed = get_setting('walk_speed', '1.2')
    for k, v in data.items():
        set_setting(k, v)
    new_scale = get_setting('scale', '0.1')
    new_speed = get_setting('walk_speed', '1.2')
    # scale 或 walk_speed 变更 → 自动重算所有动线和路径的通行耗时
    recalculated = str(old_scale) != str(new_scale) or str(old_speed) != str(new_speed)
    if recalculated:
        recalculate_travel_times()
    return jsonify({"updated": list(data.keys()), "recalculated": recalculated})


# ---------- API: 点位类型 ----------

@app.route('/api/point-types', methods=['GET'])
def get_point_types():
    conn = get_db()
    rows = conn.execute("SELECT * FROM point_types ORDER BY sort").fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route('/api/point-types', methods=['POST'])
def add_point_type():
    data = request.json
    key = data.get('key', '').strip()
    if not key:
        return jsonify({"error": "类型标识不能为空"}), 400
    label = data.get('label', '').strip()
    if not label:
        return jsonify({"error": "类型名称不能为空"}), 400
    color = data.get('color', '#5b8def')
    icon = data.get('icon', '?')[:2]
    sort = int(data.get('sort', 99))
    conn = get_db()
    try:
        conn.execute("INSERT INTO point_types(key, label, color, icon, sort) VALUES(?,?,?,?,?)",
                     (key, label, color, icon, sort))
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        return jsonify({"error": f"类型 '{key}' 已存在"}), 409
    conn.close()
    return jsonify({"key": key, "label": label, "color": color, "icon": icon, "sort": sort}), 201


@app.route('/api/point-types/<key>', methods=['PUT'])
def update_point_type(key):
    data = request.json
    conn = get_db()
    row = conn.execute("SELECT * FROM point_types WHERE key=?", (key,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "类型不存在"}), 404
    label = data.get('label', row['label'])
    color = data.get('color', row['color'])
    icon = data.get('icon', row['icon'])[:2]
    sort = data.get('sort', row['sort'])
    conn.execute("UPDATE point_types SET label=?, color=?, icon=?, sort=? WHERE key=?",
                 (label, color, icon, sort, key))
    conn.commit()
    conn.close()
    return jsonify({"key": key, "label": label, "color": color, "icon": icon, "sort": sort})


@app.route('/api/point-types/<key>', methods=['DELETE'])
def delete_point_type(key):
    # 系统类型不允许删除
    system_types = {'start', 'end', 'pickup', 'intersection'}
    if key in system_types:
        return jsonify({"error": "系统内置类型不允许删除"}), 400
    conn = get_db()
    # 检查是否有点位正在使用该类型
    count = conn.execute("SELECT COUNT(*) as cnt FROM points WHERE type=?", (key,)).fetchone()['cnt']
    if count > 0:
        conn.close()
        return jsonify({"error": f"有 {count} 个点位正在使用该类型，无法删除"}), 400
    conn.execute("DELETE FROM point_types WHERE key=?", (key,))
    conn.commit()
    conn.close()
    return jsonify({"deleted": key})


# ---------- API: 导出 ----------

@app.route('/api/export/points', methods=['GET'])
def export_points():
    conn = get_db()
    rows = conn.execute("SELECT id, x, y, type FROM points ORDER BY id").fetchall()
    conn.close()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(['点位ID', 'X坐标', 'Y坐标', '点位类型'])
    for r in rows:
        writer.writerow([r['id'], r['x'], r['y'], point_type_label(r['type'])])
    output.seek(0)
    return Response(
        output.getvalue(),
        mimetype='text/csv',
        headers={"Content-Disposition": "attachment;filename=points.csv"}
    )


@app.route('/api/export/lines', methods=['GET'])
def export_lines():
    scale = float(get_setting('scale', '0.1'))
    conn = get_db()
    rows = conn.execute("""
        SELECT l.id, l.start_point_id, l.end_point_id, l.distance, l.travel_time
        FROM lines l ORDER BY l.id
    """).fetchall()
    conn.close()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(['动线ID', '起点ID', '终点ID', '移动距离(mm)', '通行耗时(秒)'])
    for r in rows:
        distance_mm = round(r['distance'] * scale * 1000, 1)
        writer.writerow([r['id'], r['start_point_id'], r['end_point_id'], distance_mm, r['travel_time']])
    output.seek(0)
    return Response(
        output.getvalue(),
        mimetype='text/csv',
        headers={"Content-Disposition": "attachment;filename=lines.csv"}
    )


@app.route('/api/export/paths', methods=['GET'])
def export_paths():
    """流式导出路径数据 CSV，距离单位为毫米"""
    scale = float(get_setting('scale', '0.1'))
    def generate():
        conn = get_db()
        # 先写表头
        header_buf = io.StringIO()
        hw = csv.writer(header_buf)
        hw.writerow(['起点ID', '终点ID', '最短距离(mm)', '通行耗时(秒)', '路径详情'])
        yield header_buf.getvalue()
        # 分批读取
        batch_size = 10000
        offset = 0
        while True:
            rows = conn.execute(
                "SELECT start_point_id, end_point_id, distance, travel_time, route FROM paths ORDER BY id LIMIT ? OFFSET ?",
                (batch_size, offset)
            ).fetchall()
            if not rows:
                break
            buf = io.StringIO()
            w = csv.writer(buf)
            for r in rows:
                route_str = ' → '.join(json.loads(r['route'])) if r['route'] else ''
                distance_mm = round(r['distance'] * scale * 1000, 1) if r['distance'] >= 0 else -1
                w.writerow([r['start_point_id'], r['end_point_id'],
                            distance_mm, r['travel_time'], route_str])
            yield buf.getvalue()
            offset += batch_size
        conn.close()

    return Response(
        generate(),
        mimetype='text/csv',
        headers={"Content-Disposition": "attachment;filename=paths.csv"}
    )


@app.route('/api/export/database', methods=['GET'])
def export_database():
    """下载数据库文件"""
    if not os.path.exists(DB_PATH):
        return jsonify({"error": "数据库文件不存在"}), 404
    return send_file(DB_PATH, as_attachment=True, download_name='warehouse.db')


@app.route('/api/export/svg', methods=['GET'])
def export_svg():
    """导出带坐标参数的矢量图 (SVG)
    查询参数:
      transparent=1  透明背景（仅保留点和线）
      labels=0       不含文字标签（点位ID/坐标、距离标注）
      grid=0         不含网格和坐标轴
      legend=0       不含图例信息框
    """
    transparent = request.args.get('transparent', '0') == '1'
    show_labels = request.args.get('labels', '1') == '1'
    show_grid = request.args.get('grid', '1') == '1'
    show_legend = request.args.get('legend', '1') == '1'

    # 透明模式下默认关闭网格/坐标轴/图例（仍可通过参数覆盖）
    if transparent:
        show_grid = request.args.get('grid', '0') == '1'
        show_legend = request.args.get('legend', '0') == '1'

    conn = get_db()
    points = [dict(r) for r in conn.execute("SELECT * FROM points ORDER BY id").fetchall()]
    lines = [dict(r) for r in conn.execute("SELECT * FROM lines ORDER BY id").fetchall()]
    pt_types = {r['key']: dict(r) for r in conn.execute("SELECT * FROM point_types ORDER BY sort").fetchall()}
    scale = float(get_setting('scale', '0.1'))
    walk_speed = float(get_setting('walk_speed', '1.2'))
    conn.close()

    if not points:
        return jsonify({"error": "没有点位数据"}), 400

    # 计算包围盒
    xs = [p['x'] for p in points]
    ys = [p['y'] for p in points]
    grid = 50
    pad = 60 if transparent else 120
    minX = math.floor((min(xs) - pad) / grid) * grid
    maxX = math.ceil((max(xs) + pad) / grid) * grid
    minY = math.floor((min(ys) - pad) / grid) * grid
    maxY = math.ceil((max(ys) + pad) / grid) * grid
    w = maxX - minX
    h = maxY - minY

    # SVG Y 轴翻转（SVG 原点在左上角）
    def sx(x):
        return round(x - minX, 1)
    def sy(y):
        return round(maxY - y, 1)

    parts = []
    parts.append(f'<?xml version="1.0" encoding="UTF-8"?>')
    parts.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
                 f'width="{w}" height="{h}" '
                 f'font-family="Segoe UI, Microsoft YaHei, sans-serif">')

    # 背景（透明模式下跳过）
    if not transparent:
        parts.append(f'<rect width="{w}" height="{h}" fill="#1a1d2e"/>')

    # 网格 + 坐标轴 + 刻度标签
    if show_grid:
        # 次要网格
        parts.append('<g stroke="rgba(255,255,255,0.05)" stroke-width="1">')
        x = minX
        while x <= maxX:
            parts.append(f'<line x1="{sx(x)}" y1="0" x2="{sx(x)}" y2="{h}"/>')
            x += grid
        y = minY
        while y <= maxY:
            parts.append(f'<line x1="0" y1="{sy(y)}" x2="{w}" y2="{sy(y)}"/>')
            y += grid
        parts.append('</g>')

        # 主要网格（每5格）
        major = grid * 5
        parts.append('<g stroke="rgba(255,255,255,0.1)" stroke-width="1">')
        x = minX
        while x <= maxX:
            parts.append(f'<line x1="{sx(x)}" y1="0" x2="{sx(x)}" y2="{h}"/>')
            x += major
        y = minY
        while y <= maxY:
            parts.append(f'<line x1="0" y1="{sy(y)}" x2="{w}" y2="{sy(y)}"/>')
            y += major
        parts.append('</g>')

        # 坐标轴（X=0, Y=0）
        if 0 >= minY and 0 <= maxY:
            y0 = sy(0)
            parts.append(f'<line x1="0" y1="{y0}" x2="{w}" y2="{y0}" stroke="rgba(91,141,239,0.4)" stroke-width="1.5"/>')
        if 0 >= minX and 0 <= maxX:
            x0 = sx(0)
            parts.append(f'<line x1="{x0}" y1="0" x2="{x0}" y2="{h}" stroke="rgba(91,141,239,0.4)" stroke-width="1.5"/>')

        # 坐标刻度标签
        parts.append('<g fill="#6b7186" font-size="11" font-family="Consolas, monospace">')
        x = minX
        while x <= maxX:
            if x % major == 0:
                parts.append(f'<text x="{sx(x)}" y="{h - 6}" text-anchor="middle">{x}</text>')
            x += grid
        y = minY
        while y <= maxY:
            if y % major == 0:
                parts.append(f'<text x="8" y="{sy(y) + 4}" text-anchor="start">{y}</text>')
            y += grid
        parts.append('</g>')

    # 动线
    line_stroke = 'rgba(255,255,255,0.35)' if not transparent else '#888888'
    label_bg = 'rgba(0,0,0,0.7)' if not transparent else 'rgba(255,255,255,0.85)'
    label_fg = '#9298ad' if not transparent else '#333333'
    parts.append('<g>')
    for ln in lines:
        sp = next((p for p in points if p['id'] == ln['start_point_id']), None)
        ep = next((p for p in points if p['id'] == ln['end_point_id']), None)
        if not sp or not ep:
            continue
        x1, y1 = sx(sp['x']), sy(sp['y'])
        x2, y2 = sx(ep['x']), sy(ep['y'])
        parts.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{line_stroke}" stroke-width="2"/>')
        # 箭头
        angle = math.atan2(y2 - y1, x2 - x1)
        alen = 8
        ax1 = round(x2 - alen * math.cos(angle - math.pi / 6), 1)
        ay1 = round(y2 - alen * math.sin(angle - math.pi / 6), 1)
        ax2 = round(x2 - alen * math.cos(angle + math.pi / 6), 1)
        ay2 = round(y2 - alen * math.sin(angle + math.pi / 6), 1)
        parts.append(f'<line x1="{x2}" y1="{y2}" x2="{ax1}" y2="{ay1}" stroke="{line_stroke}" stroke-width="2"/>')
        parts.append(f'<line x1="{x2}" y1="{y2}" x2="{ax2}" y2="{ay2}" stroke="{line_stroke}" stroke-width="2"/>')
        # 距离标签
        if show_labels:
            mx, my = round((x1 + x2) / 2, 1), round((y1 + y2) / 2, 1)
            dist_mm = round(ln['distance'] * scale * 1000, 0)
            label = f'{dist_mm}mm'
            label_w = max(44, len(label) * 7 + 10)
            parts.append(f'<rect x="{mx - label_w/2}" y="{my - 9}" width="{label_w}" height="16" fill="{label_bg}" rx="2"/>')
            parts.append(f'<text x="{mx}" y="{my + 3}" text-anchor="middle" fill="{label_fg}" font-size="11" '
                         f'font-family="Consolas, monospace">{label}</text>')
    parts.append('</g>')

    # 点位
    id_label_bg = 'rgba(0,0,0,0.7)' if not transparent else 'rgba(255,255,255,0.85)'
    id_label_fg = '#e4e7ef' if not transparent else '#333333'
    coord_label_fg = '#6b7186' if not transparent else '#999999'
    parts.append('<g>')
    for p in points:
        pt = pt_types.get(p['type'], {'color': '#f0a93b', 'icon': '?', 'label': p['type']})
        cx, cy = sx(p['x']), sy(p['y'])
        parts.append(f'<circle cx="{cx}" cy="{cy}" r="8" fill="{pt["color"]}" stroke="rgba(0,0,0,0.3)" stroke-width="1"/>')
        parts.append(f'<text x="{cx}" y="{cy + 4}" text-anchor="middle" fill="#fff" font-size="10" '
                     f'font-weight="bold">{pt["icon"]}</text>')
        if show_labels:
            # ID 标签
            parts.append(f'<rect x="{cx - 24}" y="{cy + 12}" width="48" height="14" fill="{id_label_bg}" rx="2"/>')
            parts.append(f'<text x="{cx}" y="{cy + 22}" text-anchor="middle" fill="{id_label_fg}" font-size="11" '
                         f'font-family="Consolas, monospace">{p["id"]}</text>')
            # 坐标标签
            parts.append(f'<text x="{cx}" y="{cy - 14}" text-anchor="middle" fill="{coord_label_fg}" font-size="9" '
                         f'font-family="Consolas, monospace">({p["x"]}, {p["y"]})</text>')
    parts.append('</g>')

    # 图例信息框
    if show_legend:
        info_lines = [
            f'仓内地图矢量图 — 比例: 1px={scale * 1000}mm  步速: {walk_speed}m/s',
            f'点位: {len(points)}  动线: {len(lines)}  导出: {datetime.now().strftime("%Y-%m-%d %H:%M")}',
        ]
        used_types = sorted(set(p['type'] for p in points))
        legend_items = []
        for key in used_types:
            pt = pt_types.get(key, {'color': '#f0a93b', 'icon': '?', 'label': key})
            cnt = sum(1 for p in points if p['type'] == key)
            legend_items.append((pt['color'], pt['icon'], pt['label'], cnt))

        box_h = 28 + len(info_lines) * 16 + 22 + len(legend_items) * 20
        box_w = 300
        parts.append(f'<rect x="10" y="10" width="{box_w}" height="{box_h}" fill="rgba(35,39,54,0.92)" '
                     f'stroke="rgba(61,67,88,0.8)" stroke-width="1" rx="4"/>')
        ty = 28
        for line in info_lines:
            parts.append(f'<text x="20" y="{ty}" fill="#9298ad" font-size="11">{line}</text>')
            ty += 16
        ty += 8
        parts.append(f'<text x="20" y="{ty}" fill="#6b7186" font-size="10" font-weight="600">图例</text>')
        ty += 14
        for color, icon, label, cnt in legend_items:
            parts.append(f'<circle cx="28" cy="{ty - 3}" r="6" fill="{color}"/>')
            parts.append(f'<text x="28" y="{ty}" text-anchor="middle" fill="#fff" font-size="8" font-weight="bold">{icon}</text>')
            parts.append(f'<text x="42" y="{ty}" fill="#e4e7ef" font-size="11">{label} ({cnt})</text>')
            ty += 20

    parts.append('</svg>')
    svg_content = '\n'.join(parts)
    return Response(
        svg_content,
        mimetype='image/svg+xml',
        headers={"Content-Disposition": "attachment;filename=warehouse-map.svg"}
    )


# ---------- API: 导入 ----------

@app.route('/api/import', methods=['POST'])
def import_data():
    """导入完整配置数据（JSON）
    请求参数:
      mode:  'replace' (默认，清空后导入) | 'merge' (保留已有，仅新增)
      data:  { points, lines, point_types, settings }
    """
    body = request.json or {}
    mode = body.get('mode', 'replace')
    data = body.get('data', body)  # 兼容直接传 data 的旧格式

    conn = get_db()
    stats = {'points': 0, 'lines': 0, 'point_types': 0, 'settings': 0, 'skipped': 0}

    # replace 模式：先清空
    if mode == 'replace':
        conn.execute("DELETE FROM paths")
        conn.execute("DELETE FROM lines")
        conn.execute("DELETE FROM points")
        # 不删除系统点位类型，只清空自定义
        conn.execute("DELETE FROM point_types WHERE key NOT IN ('start','end','pickup','intersection')")

    # --- 导入点位类型 ---
    for pt in data.get('point_types', []):
        key = pt.get('key', '').strip()
        if not key:
            stats['skipped'] += 1
            continue
        try:
            conn.execute(
                "INSERT OR REPLACE INTO point_types(key, label, color, icon, sort) VALUES(?,?,?,?,?)",
                (key, pt.get('label', key), pt.get('color', '#5b8def'),
                 pt.get('icon', '?')[:2], int(pt.get('sort', 99)))
            )
            stats['point_types'] += 1
        except Exception:
            stats['skipped'] += 1

    # --- 导入点位 ---
    for p in data.get('points', []):
        try:
            pid = p['id']
            x = float(p['x'])
            y = float(p['y'])
            ptype = p.get('type', 'intersection')
            conn.execute(
                "INSERT OR REPLACE INTO points(id, x, y, type) VALUES(?,?,?,?)",
                (pid, x, y, ptype)
            )
            stats['points'] += 1
        except Exception:
            stats['skipped'] += 1

    # --- 导入动线 ---
    walk_speed = float(get_setting('walk_speed', '1.2'))
    scale = float(get_setting('scale', '0.1'))
    # 重新读取点位缓存（可能刚导入）
    point_cache = {r['id']: (r['x'], r['y']) for r in conn.execute("SELECT * FROM points").fetchall()}
    for ln in data.get('lines', []):
        sp = ln.get('start_point_id', '').strip()
        ep = ln.get('end_point_id', '').strip()
        if sp == ep or sp not in point_cache or ep not in point_cache:
            stats['skipped'] += 1
            continue
        if ln.get('distance') is not None:
            dist = float(ln['distance'])
        else:
            sx, sy = point_cache[sp]
            ex, ey = point_cache[ep]
            dist = calc_distance(sx, sy, ex, ey)
        tt = calc_travel_time(dist, scale, walk_speed)
        # merge 模式下检查是否已存在
        if mode == 'merge':
            exists = conn.execute(
                "SELECT 1 FROM lines WHERE (start_point_id=? AND end_point_id=?) OR (start_point_id=? AND end_point_id=?)",
                (sp, ep, ep, sp)
            ).fetchone()
            if exists:
                stats['skipped'] += 1
                continue
        try:
            conn.execute(
                "INSERT INTO lines(start_point_id, end_point_id, distance, travel_time) VALUES(?,?,?,?)",
                (sp, ep, round(dist, 2), tt)
            )
            stats['lines'] += 1
        except Exception:
            stats['skipped'] += 1

    # --- 导入设置 ---
    for k, v in data.get('settings', {}).items():
        conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES(?,?)", (k, str(v)))
        stats['settings'] += 1

    # 导入数据后路径失效
    if stats['points'] > 0 or stats['lines'] > 0:
        invalidate_paths(conn)
    conn.commit()
    conn.close()
    return jsonify({"imported": True, "mode": mode, "stats": stats})


# ---------- API: 导出全量 JSON ----------

@app.route('/api/export/json', methods=['GET'])
def export_json():
    conn = get_db()
    points = [dict(r) for r in conn.execute("SELECT * FROM points ORDER BY id").fetchall()]
    lines = [dict(r) for r in conn.execute("SELECT * FROM lines ORDER BY id").fetchall()]
    point_types = [dict(r) for r in conn.execute("SELECT * FROM point_types ORDER BY sort").fetchall()]
    settings = {r['key']: r['value'] for r in conn.execute("SELECT * FROM settings").fetchall()}
    conn.close()
    return jsonify({
        "points": points,
        "lines": lines,
        "point_types": point_types,
        "settings": settings,
        "exported_at": datetime.now().isoformat()
    })


# ---------- 页面 ----------

@app.route('/')
def index():
    return render_template('index.html')


if __name__ == '__main__':
    init_db()
    app.run(debug=True, host='0.0.0.0', port=5180)
