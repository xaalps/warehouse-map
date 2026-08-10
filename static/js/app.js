/**
 * 仓内地图数据采集系统 - 前端应用
 * Canvas 地图编辑器 + API 交互
 */

// ===== 全局状态 =====
const state = {
    points: [],          // [{id, x, y, type}]
    lines: [],            // [{id, start_point_id, end_point_id, distance, travel_time}]
    paths: [],            // 路径数据（分页）
    pathTotal: 0,
    pathPage: 1,
    pathPerPage: 50,
    settings: { walk_speed: '1.2', scale: '0.1' },
    mode: 'add-point',    // add-point | add-line | move | delete
    selectedPoint: null,  // 连线模式下选中的第一个点
    draggingPoint: null,  // 拖拽中的点位
    hoveredPoint: null,
    hoveredLine: null,
    selectedLine: null,
    scale: 1,             // 画布缩放
    offsetX: 0,           // 画布偏移
    offsetY: 0,
    showGrid: true,
    showLabels: true,
    activeTab: 'points',
    aislePickTarget: null,  // 'start' | 'end' | null — 通道拾取模式
    editingPoint: null,     // 当前正在编辑的点位
};

// 点位类型配置（从后端动态加载）
let POINT_TYPES = {
    start:        { label: '出发点', color: '#3ecf8e', icon: 'S' },
    end:          { label: '终止点', color: '#ef5b5b', icon: 'E' },
    pickup:       { label: '取货点', color: '#5b8def', icon: 'P' },
    intersection: { label: '岔路点', color: '#f0a93b', icon: 'X' },
};

const SYSTEM_TYPE_KEYS = new Set(['start', 'end', 'pickup', 'intersection']);

// 像素距离 → 毫米
function pxToMm(px) {
    const scale = parseFloat(state.settings.scale) || 0.1;
    return (px * scale * 1000).toFixed(0);
}

// ===== Canvas =====
let canvas, ctx, wrapper;
let canvasWidth = 0, canvasHeight = 0;

function initCanvas() {
    canvas = document.getElementById('map-canvas');
    ctx = canvas.getContext('2d');
    wrapper = document.getElementById('canvas-wrapper');

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mouseleave', onMouseLeave);
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDoubleClick);

    // Y 轴向上为正：原点设为画布中心
    state.offsetX = canvasWidth / 2;
    state.offsetY = canvasHeight / 2;
    render();
}

function resizeCanvas() {
    const rect = wrapper.getBoundingClientRect();
    canvasWidth = rect.width;
    canvasHeight = rect.height;
    canvas.width = canvasWidth * window.devicePixelRatio;
    canvas.height = canvasHeight * window.devicePixelRatio;
    canvas.style.width = canvasWidth + 'px';
    canvas.style.height = canvasHeight + 'px';
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    render();
}

// ===== 坐标转换 =====
// Y 轴向上为正（数学坐标系），Canvas 原生 Y 向下，通过取反实现翻转
function screenToWorld(sx, sy) {
    return {
        x: (sx - state.offsetX) / state.scale,
        y: -(sy - state.offsetY) / state.scale,
    };
}

function worldToScreen(wx, wy) {
    return {
        x: wx * state.scale + state.offsetX,
        y: -wy * state.scale + state.offsetY,
    };
}

// ===== 渲染 =====
function render() {
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    ctx.fillStyle = '#1a1d2e';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    if (state.showGrid) drawGrid();
    drawLines();
    drawAislePreview();
    drawPoints();

    // 连线模式预览
    if (state.mode === 'add-line' && state.selectedPoint && state.hoveredPoint && state.hoveredPoint.id !== state.selectedPoint) {
        drawPreviewLine(state.selectedPoint, state.hoveredPoint.id);
    }
}

function drawGrid() {
    const gridSize = 50 * state.scale;
    if (gridSize < 10) return;
    
    const startX = state.offsetX % gridSize;
    const startY = state.offsetY % gridSize;

    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = startX; x < canvasWidth; x += gridSize) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvasHeight);
    }
    for (let y = startY; y < canvasHeight; y += gridSize) {
        ctx.moveTo(0, y);
        ctx.lineTo(canvasWidth, y);
    }
    ctx.stroke();

    // 主网格线
    const majorSize = gridSize * 5;
    if (majorSize >= 50) {
        const majorX = state.offsetX % majorSize;
        const majorY = state.offsetY % majorSize;
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.beginPath();
        for (let x = majorX; x < canvasWidth; x += majorSize) {
            ctx.moveTo(x, 0);
            ctx.lineTo(x, canvasHeight);
        }
        for (let y = majorY; y < canvasHeight; y += majorSize) {
            ctx.moveTo(0, y);
            ctx.lineTo(canvasWidth, y);
        }
        ctx.stroke();
    }

    // 原点十字线
    const origin = worldToScreen(0, 0);
    if (origin.x >= 0 && origin.x <= canvasWidth) {
        ctx.strokeStyle = 'rgba(91,141,239,0.3)';
        ctx.beginPath();
        ctx.moveTo(origin.x, 0);
        ctx.lineTo(origin.x, canvasHeight);
        ctx.stroke();
    }
    if (origin.y >= 0 && origin.y <= canvasHeight) {
        ctx.strokeStyle = 'rgba(91,141,239,0.3)';
        ctx.beginPath();
        ctx.moveTo(0, origin.y);
        ctx.lineTo(canvasWidth, origin.y);
        ctx.stroke();
    }

    // 坐标轴箭头与标签（Y 向上为正）
    if (origin.x >= 0 && origin.x <= canvasWidth && origin.y >= 20) {
        // Y 轴箭头（向上）
        ctx.strokeStyle = 'rgba(91,141,239,0.6)';
        ctx.fillStyle = 'rgba(91,141,239,0.6)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(origin.x, origin.y);
        ctx.lineTo(origin.x, origin.y - 30);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(origin.x, origin.y - 30);
        ctx.lineTo(origin.x - 4, origin.y - 24);
        ctx.lineTo(origin.x + 4, origin.y - 24);
        ctx.closePath();
        ctx.fill();
        ctx.font = 'bold 11px Consolas';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('Y', origin.x + 6, origin.y - 26);
    }
    if (origin.y >= 0 && origin.y <= canvasHeight && origin.x <= canvasWidth - 30) {
        // X 轴箭头（向右）
        ctx.strokeStyle = 'rgba(91,141,239,0.6)';
        ctx.fillStyle = 'rgba(91,141,239,0.6)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(origin.x, origin.y);
        ctx.lineTo(origin.x + 30, origin.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(origin.x + 30, origin.y);
        ctx.lineTo(origin.x + 24, origin.y - 4);
        ctx.lineTo(origin.x + 24, origin.y + 4);
        ctx.closePath();
        ctx.fill();
        ctx.font = 'bold 11px Consolas';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('X', origin.x + 33, origin.y);
    }
    // 原点标签
    if (origin.x >= 0 && origin.x <= canvasWidth && origin.y >= 0 && origin.y <= canvasHeight) {
        ctx.font = '10px Consolas';
        ctx.fillStyle = 'rgba(91,141,239,0.5)';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.fillText('0', origin.x - 4, origin.y + 4);
    }
}

function drawLines() {
    for (const ln of state.lines) {
        const sp = state.points.find(p => p.id === ln.start_point_id);
        const ep = state.points.find(p => p.id === ln.end_point_id);
        if (!sp || !ep) continue;

        const s1 = worldToScreen(sp.x, sp.y);
        const s2 = worldToScreen(ep.x, ep.y);

        const isHovered = state.hoveredLine && state.hoveredLine.id === ln.id;
        const isSelected = state.selectedLine && state.selectedLine.id === ln.id;

        ctx.strokeStyle = isHovered ? '#42b3d4' : (isSelected ? '#ef5b5b' : 'rgba(255,255,255,0.25)');
        ctx.lineWidth = isHovered ? 3 : 2;
        ctx.beginPath();
        ctx.moveTo(s1.x, s1.y);
        ctx.lineTo(s2.x, s2.y);
        ctx.stroke();

        // 箭头
        drawArrow(s1.x, s1.y, s2.x, s2.y);

        // 距离标签
        if (state.showLabels) {
            const mx = (s1.x + s2.x) / 2;
            const my = (s1.y + s2.y) / 2;
            const label = `${pxToMm(ln.distance)} mm`;
            ctx.font = '11px Consolas';
            const tw = ctx.measureText(label).width;
            ctx.fillStyle = 'rgba(0,0,0,0.7)';
            ctx.fillRect(mx - tw/2 - 4, my - 10, tw + 8, 16);
            ctx.fillStyle = '#9298ad';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, mx, my - 2);
        }
    }
}

function drawArrow(x1, y1, x2, y2) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const len = 8;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
        x2 - len * Math.cos(angle - Math.PI / 6),
        y2 - len * Math.sin(angle - Math.PI / 6)
    );
    ctx.moveTo(x2, y2);
    ctx.lineTo(
        x2 - len * Math.cos(angle + Math.PI / 6),
        y2 - len * Math.sin(angle + Math.PI / 6)
    );
    ctx.stroke();
}

function drawPoints() {
    for (const p of state.points) {
        const s = worldToScreen(p.x, p.y);
        const cfg = POINT_TYPES[p.type] || POINT_TYPES.intersection;
        const radius = 8;
        const isHovered = state.hoveredPoint && state.hoveredPoint.id === p.id;
        const isSelected = state.selectedPoint === p.id;

        // 外圈光晕
        if (isHovered || isSelected) {
            ctx.beginPath();
            ctx.arc(s.x, s.y, radius + 6, 0, Math.PI * 2);
            ctx.fillStyle = cfg.color + '30';
            ctx.fill();
        }

        // 主圆
        ctx.beginPath();
        ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = cfg.color;
        ctx.fill();
        ctx.strokeStyle = isSelected ? '#fff' : 'rgba(0,0,0,0.3)';
        ctx.lineWidth = isSelected ? 2 : 1;
        ctx.stroke();

        // 图标
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(cfg.icon, s.x, s.y);

        // 标签
        if (state.showLabels) {
            ctx.font = '11px Consolas';
            ctx.fillStyle = 'rgba(0,0,0,0.7)';
            const label = p.id;
            const tw = ctx.measureText(label).width;
            ctx.fillRect(s.x - tw/2 - 3, s.y + radius + 2, tw + 6, 14);
            ctx.fillStyle = '#e4e7ef';
            ctx.fillText(label, s.x, s.y + radius + 9);
        }
    }
}

function drawPreviewLine(fromId, toId) {
    const sp = state.points.find(p => p.id === fromId);
    const ep = state.points.find(p => p.id === toId);
    if (!sp || !ep) return;
    const s1 = worldToScreen(sp.x, sp.y);
    const s2 = worldToScreen(ep.x, ep.y);
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = '#42b3d4';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s1.x, s1.y);
    ctx.lineTo(s2.x, s2.y);
    ctx.stroke();
    ctx.setLineDash([]);
}

// ===== 命中检测 =====
function getPointAt(sx, sy) {
    for (let i = state.points.length - 1; i >= 0; i--) {
        const p = state.points[i];
        const s = worldToScreen(p.x, p.y);
        const dx = sx - s.x, dy = sy - s.y;
        if (dx * dx + dy * dy <= 144) return p; // 12px radius
    }
    return null;
}

function getLineAt(sx, sy) {
    for (const ln of state.lines) {
        const sp = state.points.find(p => p.id === ln.start_point_id);
        const ep = state.points.find(p => p.id === ln.end_point_id);
        if (!sp || !ep) continue;
        const s1 = worldToScreen(sp.x, sp.y);
        const s2 = worldToScreen(ep.x, ep.y);
        if (distToSegment(sx, sy, s1.x, s1.y, s2.x, s2.y) < 8) return ln;
    }
    return null;
}

function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    if (dx === 0 && dy === 0) return Math.hypot(px - x1, py - y1);
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// ===== 鼠标事件 =====
function getMousePos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function onMouseDown(e) {
    const pos = getMousePos(e);

    // 通道拾取模式优先处理
    if (state.aislePickTarget) {
        if (e.button === 2) {
            e.preventDefault();
            cancelAislePick();
            return;
        }
        handleAislePick(pos);
        return;
    }

    const world = screenToWorld(pos.x, pos.y);
    const point = getPointAt(pos.x, pos.y);

    if (e.button === 2) { // 右键
        e.preventDefault();
        if (point) {
            deletePoint(point.id);
        } else {
            const line = getLineAt(pos.x, pos.y);
            if (line) deleteLine(line.id);
        }
        return;
    }

    switch (state.mode) {
        case 'add-point':
            if (!point) {
                addPoint(world.x, world.y);
            }
            break;

        case 'add-line':
            if (point) {
                if (state.selectedPoint === point.id) {
                    state.selectedPoint = null;
                } else if (state.selectedPoint) {
                    addLine(state.selectedPoint, point.id);
                    state.selectedPoint = null;
                } else {
                    state.selectedPoint = point.id;
                }
                render();
            }
            break;

        case 'move':
            if (point) {
                state.draggingPoint = point;
            } else {
                // 拖拽画布
                state._panStart = { x: pos.x, y: pos.y, offsetX: state.offsetX, offsetY: state.offsetY };
            }
            break;

        case 'delete':
            if (point) {
                deletePoint(point.id);
            } else {
                const line = getLineAt(pos.x, pos.y);
                if (line) deleteLine(line.id);
            }
            break;
    }
}

function onMouseMove(e) {
    const pos = getMousePos(e);
    const world = screenToWorld(pos.x, pos.y);
    document.getElementById('coord-display').textContent = `X: ${world.x.toFixed(1)}, Y: ${world.y.toFixed(1)}`;

    // 拖拽画布
    if (state._panStart) {
        state.offsetX = state._panStart.offsetX + (pos.x - state._panStart.x);
        state.offsetY = state._panStart.offsetY + (pos.y - state._panStart.y);
        render();
        return;
    }

    // 拖拽点位
    if (state.draggingPoint) {
        state.draggingPoint.x = world.x;
        state.draggingPoint.y = world.y;
        render();
        return;
    }

    // hover 检测
    const point = getPointAt(pos.x, pos.y);
    const line = point ? null : getLineAt(pos.x, pos.y);
    const newHoveredPoint = point;
    const newHoveredLine = line;

    if (newHoveredPoint !== state.hoveredPoint || newHoveredLine !== state.hoveredLine) {
        state.hoveredPoint = newHoveredPoint;
        state.hoveredLine = newHoveredLine;
        render();
    }

    // 连线模式预览
    if (state.mode === 'add-line' && state.selectedPoint) {
        render();
    }

    // 光标
    if (state.aislePickTarget) {
        canvas.style.cursor = point ? 'pointer' : 'crosshair';
    } else if (point) {
        canvas.style.cursor = state.mode === 'move' ? 'grab' : 'pointer';
    } else if (line) {
        canvas.style.cursor = 'pointer';
    } else {
        canvas.style.cursor = state.mode === 'move' ? 'grab' : 'crosshair';
    }
}

function onMouseUp(e) {
    if (state.draggingPoint) {
        // 同步到后端
        updatePoint(state.draggingPoint);
        state.draggingPoint = null;
    }
    state._panStart = null;
}

function onMouseLeave() {
    state.hoveredPoint = null;
    state.hoveredLine = null;
    state.draggingPoint = null;
    state._panStart = null;
    render();
}

function onContextMenu(e) {
    e.preventDefault();
}

function onWheel(e) {
    e.preventDefault();
    const pos = getMousePos(e);
    const worldBefore = screenToWorld(pos.x, pos.y);
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    state.scale = Math.max(0.1, Math.min(10, state.scale * factor));
    const worldAfter = screenToWorld(pos.x, pos.y);
    state.offsetX += (worldAfter.x - worldBefore.x) * state.scale;
    state.offsetY -= (worldAfter.y - worldBefore.y) * state.scale;
    render();
}

function onDoubleClick(e) {
    const pos = getMousePos(e);
    const point = getPointAt(pos.x, pos.y);
    if (point) {
        openEditPoint(point.id);
    }
}

// ===== 模式 =====
function setMode(mode) {
    state.mode = mode;
    state.selectedPoint = null;
    state.selectedLine = null;
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    const modeNames = {
        'add-point': '添加点位',
        'add-line': '连线动线',
        'move': '拖拽移动',
        'delete': '删除元素',
    };
    document.getElementById('current-mode-text').textContent = modeNames[mode];

    const hints = {
        'add-point': '点击画布添加点位（先选择点位类型）',
        'add-line': '依次点击两个点位创建动线',
        'move': '拖拽点位移动位置，或拖拽空白区域平移画布',
        'delete': '点击点位或动线进行删除（右键也可删除）',
    };
    document.getElementById('canvas-hint').textContent = hints[mode];

    // 显示/隐藏点位类型面板
    document.getElementById('point-type-panel').style.display = mode === 'add-point' ? '' : 'none';
    render();
}

function getSelectedPointType() {
    const checked = document.querySelector('input[name="point-type"]:checked');
    return checked ? checked.value : 'intersection';
}

// ===== API 调用 =====
async function api(url, method = 'GET', body = null) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '请求失败');
    return data;
}

// ===== 点位操作 =====
function markPathsStale() {
    // 标记路径为过期，清空前端路径数据并显示提示
    if (state.pathTotal > 0) {
        state.paths = [];
        state.pathTotal = 0;
        renderPathList();
        updateCounts();
    }
}

function generatePointId() {
    const idLength = parseInt(state.settings.id_length) || 6;
    // 匹配以 P 开头 + 指定长度数字的 ID
    const re = new RegExp(`^P(\\d+)$`);
    let maxNum = 0;
    for (const p of state.points) {
        const m = p.id.match(re);
        if (m) maxNum = Math.max(maxNum, parseInt(m[1]));
    }
    return 'P' + String(maxNum + 1).padStart(idLength, '0');
}

async function addPoint(x, y) {
    const type = getSelectedPointType();
    const id = generatePointId();
    try {
        const result = await api('/api/points', 'POST', { id, x: Math.round(x), y: Math.round(y), type });
        state.points.push(result);
        markPathsStale();
        updateCounts();
        renderPointList();
        render();
        toast(`点位 ${id} 已添加`, 'success');
    } catch (e) {
        toast(e.message, 'error');
    }
}

async function addPointManual() {
    const id = document.getElementById('manual-point-id').value.trim();
    const x = parseFloat(document.getElementById('manual-point-x').value);
    const y = parseFloat(document.getElementById('manual-point-y').value);
    const type = getSelectedPointType();

    if (!id) return toast('请输入点位ID', 'error');
    if (isNaN(x) || isNaN(y)) return toast('请输入有效坐标', 'error');

    try {
        const result = await api('/api/points', 'POST', { id, x, y, type });
        state.points.push(result);
        markPathsStale();
        updateCounts();
        renderPointList();
        render();
        toast(`点位 ${id} 已添加`, 'success');
        document.getElementById('manual-point-id').value = '';
        document.getElementById('manual-point-x').value = '';
        document.getElementById('manual-point-y').value = '';
    } catch (e) {
        toast(e.message, 'error');
    }
}

async function updatePoint(p) {
    try {
        await api(`/api/points/${p.id}`, 'PUT', { x: p.x, y: p.y, type: p.type });
        // 更新动线距离
        await loadLines();
        markPathsStale();
        renderLineList();
        render();
    } catch (e) {
        toast(e.message, 'error');
    }
}

// ===== 点位编辑弹窗 =====
function openEditPoint(id) {
    const p = state.points.find(p => p.id === id);
    if (!p) return;
    state.editingPoint = id;
    document.getElementById('edit-point-id').value = p.id;
    document.getElementById('edit-point-x').value = p.x;
    document.getElementById('edit-point-y').value = p.y;
    updateAllTypeSelects();
    document.getElementById('edit-point-type').value = p.type;
    document.getElementById('edit-point-modal').style.display = '';
}

function closeEditPoint() {
    state.editingPoint = null;
    document.getElementById('edit-point-modal').style.display = 'none';
}

async function saveEditPoint() {
    const oldId = state.editingPoint;
    if (!oldId) return;
    const newId = document.getElementById('edit-point-id').value.trim();
    const x = parseFloat(document.getElementById('edit-point-x').value);
    const y = parseFloat(document.getElementById('edit-point-y').value);
    const type = document.getElementById('edit-point-type').value;

    if (!newId) return toast('点位ID不能为空', 'error');
    if (isNaN(x) || isNaN(y)) return toast('请输入有效坐标', 'error');

    try {
        const result = await api(`/api/points/${oldId}`, 'PUT', {
            new_id: newId, x, y, type
        });
        closeEditPoint();
        // 全量刷新（ID可能变了，动线/路径也需要更新）
        await loadAll();
        markPathsStale();
        if (result.id_changed) {
            toast(`点位已更新：${oldId} → ${newId}`, 'success');
        } else {
            toast(`点位 ${newId} 已更新`, 'success');
        }
    } catch (e) {
        toast(e.message, 'error');
    }
}

// ===== 点位类型管理 =====
function showTypeManager() {
    renderTypeManagerList();
    document.getElementById('type-manager-modal').style.display = '';
}

function hideTypeManager() {
    document.getElementById('type-manager-modal').style.display = 'none';
    // 重置新增表单
    document.getElementById('new-type-key').value = '';
    document.getElementById('new-type-label').value = '';
    document.getElementById('new-type-color').value = '#5b8def';
    document.getElementById('new-type-icon').value = '?';
}

function renderTypeManagerList() {
    const html = Object.entries(POINT_TYPES).map(([key, cfg]) => {
        const isSystem = SYSTEM_TYPE_KEYS.has(key);
        return `
            <div class="type-mgr-item">
                <div class="type-mgr-preview">
                    <span class="type-mgr-circle" style="background:${cfg.color}">${cfg.icon}</span>
                </div>
                <div class="type-mgr-info">
                    <div class="type-mgr-label">${cfg.label}</div>
                    <div class="type-mgr-key">${key}${isSystem ? ' (系统)' : ''}</div>
                </div>
                <div class="type-mgr-actions">
                    <button class="btn btn-xs" onclick="editType('${key}')">编辑</button>
                    ${!isSystem ? `<button class="btn btn-xs btn-danger" onclick="deleteType('${key}')">删除</button>` : ''}
                </div>
            </div>
        `;
    }).join('');
    document.getElementById('type-manager-list').innerHTML = html;
}

async function addNewType() {
    const key = document.getElementById('new-type-key').value.trim();
    const label = document.getElementById('new-type-label').value.trim();
    const color = document.getElementById('new-type-color').value;
    const icon = document.getElementById('new-type-icon').value.trim() || '?';

    if (!key) return toast('请输入类型标识', 'error');
    if (!label) return toast('请输入类型名称', 'error');
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) return toast('类型标识只能包含字母、数字和下划线，且以字母开头', 'error');

    try {
        await api('/api/point-types', 'POST', { key, label, color, icon, sort: 99 });
        await loadPointTypes();
        renderTypeManagerList();
        // 清空新增表单
        document.getElementById('new-type-key').value = '';
        document.getElementById('new-type-label').value = '';
        document.getElementById('new-type-icon').value = '?';
        toast(`类型 ${label} 已添加`, 'success');
    } catch (e) {
        toast(e.message, 'error');
    }
}

function editType(key) {
    const cfg = POINT_TYPES[key];
    if (!cfg) return;
    // 填入新增表单用于编辑
    document.getElementById('new-type-key').value = key;
    document.getElementById('new-type-label').value = cfg.label;
    document.getElementById('new-type-color').value = cfg.color;
    document.getElementById('new-type-icon').value = cfg.icon;
    // 滚动到表单
    document.getElementById('new-type-key').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    document.getElementById('new-type-key').disabled = true; // 编辑时不允许改key
    toast(`正在编辑类型 ${cfg.label}，修改后点击保存`, 'info');
}

async function saveType() {
    const key = document.getElementById('new-type-key').value.trim();
    const label = document.getElementById('new-type-label').value.trim();
    const color = document.getElementById('new-type-color').value;
    const icon = document.getElementById('new-type-icon').value.trim() || '?';
    const keyDisabled = document.getElementById('new-type-key').disabled;

    if (!label) return toast('请输入类型名称', 'error');

    try {
        if (keyDisabled) {
            // 编辑模式
            await api(`/api/point-types/${key}`, 'PUT', { label, color, icon });
            toast(`类型 ${label} 已更新`, 'success');
        } else {
            // 新增模式
            if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) return toast('类型标识只能包含字母、数字和下划线', 'error');
            await api('/api/point-types', 'POST', { key, label, color, icon, sort: 99 });
            toast(`类型 ${label} 已添加`, 'success');
        }
        document.getElementById('new-type-key').disabled = false;
        document.getElementById('new-type-key').value = '';
        document.getElementById('new-type-label').value = '';
        document.getElementById('new-type-icon').value = '?';
        await loadPointTypes();
        renderTypeManagerList();
    } catch (e) {
        toast(e.message, 'error');
    }
}

async function deleteType(key) {
    const cfg = POINT_TYPES[key];
    if (!confirm(`确认删除类型 ${cfg.label}？`)) return;
    try {
        await api(`/api/point-types/${key}`, 'DELETE');
        await loadPointTypes();
        renderTypeManagerList();
        toast(`类型 ${cfg.label} 已删除`, 'success');
    } catch (e) {
        toast(e.message, 'error');
    }
}

async function deletePoint(id) {
    if (!confirm(`确认删除点位 ${id}？关联动线将一并删除。`)) return;
    try {
        await api(`/api/points/${id}`, 'DELETE');
        state.points = state.points.filter(p => p.id !== id);
        state.lines = state.lines.filter(l => l.start_point_id !== id && l.end_point_id !== id);
        markPathsStale();
        updateCounts();
        renderPointList();
        renderLineList();
        render();
        toast(`点位 ${id} 已删除`, 'info');
    } catch (e) {
        toast(e.message, 'error');
    }
}

// ===== 动线操作 =====
async function addLine(startId, endId) {
    if (startId === endId) return;
    // 检查是否已存在
    const exists = state.lines.some(l =>
        (l.start_point_id === startId && l.end_point_id === endId) ||
        (l.start_point_id === endId && l.end_point_id === startId)
    );
    if (exists) return toast('该动线已存在', 'error');
    try {
        const result = await api('/api/lines', 'POST', { start_point_id: startId, end_point_id: endId });
        state.lines.push(result);
        markPathsStale();
        updateCounts();
        renderLineList();
        render();
        toast(`动线 ${startId} → ${endId} 已创建`, 'success');
    } catch (e) {
        toast(e.message, 'error');
    }
}

async function deleteLine(id) {
    if (!confirm('确认删除该动线？')) return;
    try {
        await api(`/api/lines/${id}`, 'DELETE');
        state.lines = state.lines.filter(l => l.id !== id);
        markPathsStale();
        updateCounts();
        renderLineList();
        render();
        toast('动线已删除', 'info');
    } catch (e) {
        toast(e.message, 'error');
    }
}

// ===== 通道拾取模式 =====
function startAislePick(target) {
    // 如果已激活同一个目标，则取消
    if (state.aislePickTarget === target) {
        cancelAislePick();
        return;
    }
    state.aislePickTarget = target;
    document.getElementById('pick-start-btn').classList.toggle('active', target === 'start');
    document.getElementById('pick-end-btn').classList.toggle('active', target === 'end');
    const label = target === 'start' ? '起点' : '终点';
    document.getElementById('canvas-hint').textContent =
        `请在地图上点击拾取${label} — 点击已有点位获取ID和坐标，或点击空白处仅获取坐标`;
    canvas.style.cursor = 'crosshair';
    toast(`请在地图上点击拾取${label}坐标，按 ESC 取消`, 'info');
}

function cancelAislePick() {
    state.aislePickTarget = null;
    document.getElementById('pick-start-btn').classList.remove('active');
    document.getElementById('pick-end-btn').classList.remove('active');
    // 恢复提示
    const hints = {
        'add-point': '点击画布添加点位（先选择点位类型）',
        'add-line': '依次点击两个点位创建动线',
        'move': '拖拽点位移动位置，或拖拽空白区域平移画布',
        'delete': '点击点位或动线进行删除（右键也可删除）',
    };
    document.getElementById('canvas-hint').textContent = hints[state.mode] || '';
    canvas.style.cursor = '';
    render();
}

function handleAislePick(pos) {
    const world = screenToWorld(pos.x, pos.y);
    const point = getPointAt(pos.x, pos.y);
    const target = state.aislePickTarget;
    const rx = Math.round(world.x * 10) / 10;
    const ry = Math.round(world.y * 10) / 10;

    if (target === 'start') {
        if (point) {
            document.getElementById('aisle-start-id').value = point.id;
            document.getElementById('aisle-start-x').value = Math.round(point.x * 10) / 10;
            document.getElementById('aisle-start-y').value = Math.round(point.y * 10) / 10;
            document.getElementById('aisle-start-type').value = point.type;
            toast(`已拾取起点：${point.id} (${point.x}, ${point.y})`, 'success');
        } else {
            document.getElementById('aisle-start-x').value = rx;
            document.getElementById('aisle-start-y').value = ry;
            toast(`已拾取起点坐标：(${rx}, ${ry})`, 'success');
        }
    } else if (target === 'end') {
        if (point) {
            document.getElementById('aisle-end-id').value = point.id;
            document.getElementById('aisle-end-x').value = Math.round(point.x * 10) / 10;
            document.getElementById('aisle-end-y').value = Math.round(point.y * 10) / 10;
            document.getElementById('aisle-end-type').value = point.type;
            toast(`已拾取终点：${point.id} (${point.x}, ${point.y})`, 'success');
        } else {
            document.getElementById('aisle-end-x').value = rx;
            document.getElementById('aisle-end-y').value = ry;
            toast(`已拾取终点坐标：(${rx}, ${ry})`, 'success');
        }
    }

    cancelAislePick();
}

// ===== 通道预览渲染 =====
function drawAislePreview() {
    // 读取起止点坐标
    const sx = parseFloat(document.getElementById('aisle-start-x').value);
    const sy = parseFloat(document.getElementById('aisle-start-y').value);
    const ex = parseFloat(document.getElementById('aisle-end-x').value);
    const ey = parseFloat(document.getElementById('aisle-end-y').value);
    if (isNaN(sx) || isNaN(sy) || isNaN(ex) || isNaN(ey)) return;

    const count = parseInt(document.getElementById('aisle-count').value) || 0;
    const s1 = worldToScreen(sx, sy);
    const s2 = worldToScreen(ex, ey);

    // 虚线连接起止点
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(66,179,212,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s1.x, s1.y);
    ctx.lineTo(s2.x, s2.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // 绘制货位分布预览点
    if (count > 0) {
        for (let i = 1; i <= count; i++) {
            const t = i / (count + 1);
            const px = sx + (ex - sx) * t;
            const py = sy + (ey - sy) * t;
            const s = worldToScreen(px, py);
            ctx.beginPath();
            ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(66,179,212,0.5)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(66,179,212,0.8)';
            ctx.lineWidth = 1;
            ctx.stroke();
        }
    }

    // 起止点标记
    for (const s of [s1, s2]) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(66,179,212,0.9)';
        ctx.lineWidth = 2;
        ctx.stroke();
    }
}

// ===== 通道批量生成 =====
async function generateAisle() {
    const startId = document.getElementById('aisle-start-id').value.trim();
    const startType = document.getElementById('aisle-start-type').value;
    const startX = parseFloat(document.getElementById('aisle-start-x').value);
    const startY = parseFloat(document.getElementById('aisle-start-y').value);
    const endId = document.getElementById('aisle-end-id').value.trim();
    const endType = document.getElementById('aisle-end-type').value;
    const endX = parseFloat(document.getElementById('aisle-end-x').value);
    const endY = parseFloat(document.getElementById('aisle-end-y').value);
    const count = parseInt(document.getElementById('aisle-count').value);
    const prefix = document.getElementById('aisle-prefix').value.trim() || 'P';
    const pickupType = document.getElementById('aisle-pickup-type').value || 'pickup';
    const autoConnect = document.getElementById('aisle-auto-connect').checked;

    if (!startId || !endId) return toast('请填写起点ID和终点ID', 'error');
    if (startId === endId) return toast('起点和终点不能相同', 'error');
    if (isNaN(startX) || isNaN(startY)) return toast('请填写有效的起点坐标', 'error');
    if (isNaN(endX) || isNaN(endY)) return toast('请填写有效的终点坐标', 'error');
    if (!count || count < 1) return toast('货位数量至少为1', 'error');

    showLoading('正在生成通道货位...');
    try {
        const result = await api('/api/aisle/generate', 'POST', {
            start_id: startId,
            start_x: startX,
            start_y: startY,
            start_type: startType,
            end_id: endId,
            end_x: endX,
            end_y: endY,
            end_type: endType,
            count: count,
            prefix: prefix,
            pickup_type: pickupType,
            auto_connect: autoConnect,
        });
        hideLoading();

        // 刷新数据
        await loadAll();
        markPathsStale();
        
        const msg = `通道生成完成：${result.point_count} 个点位、${result.line_count} 条动线` +
            (result.skipped > 0 ? `（跳过 ${result.skipped} 个已存在的）` : '');
        toast(msg, 'success');

        // 调整视图以包含所有新点
        fitToContent();
    } catch (e) {
        hideLoading();
        toast(e.message, 'error');
    }
}

// ===== 视图自适应 =====
function fitToContent() {
    if (state.points.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of state.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    }
    const w = maxX - minX || 100;
    const h = maxY - minY || 100;
    const padding = 80;
    const scaleX = (canvasWidth - padding * 2) / w;
    const scaleY = (canvasHeight - padding * 2) / h;
    state.scale = Math.min(scaleX, scaleY, 3);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    state.offsetX = canvasWidth / 2 - cx * state.scale;
    state.offsetY = canvasHeight / 2 + cy * state.scale;
    render();
}

// ===== 路径生成 =====
async function generatePaths() {
    if (state.points.length === 0) return toast('请先添加点位', 'error');
    if (state.lines.length === 0) return toast('请先配置动线', 'error');

    showLoading('正在生成 N×N 路径数据...');
    try {
        const result = await api('/api/paths/generate', 'POST');
        state.pathTotal = result.total;
        state.pathPage = 1;
        hideLoading();
        toast(`路径数据生成完成！共 ${result.total} 条（${result.point_count} 个点）`, 'success');
        // 移除过期提示
        const banner = document.querySelector('.path-stale-banner');
        if (banner) banner.remove();
        // 切换到路径 Tab
        switchTab('paths');
        await loadPaths();
        await loadStats();
    } catch (e) {
        hideLoading();
        toast(e.message, 'error');
    }
}

async function loadPaths() {
    try {
        const search = document.getElementById('path-search').value;
        const res = await api(`/api/paths?page=${state.pathPage}&per_page=${state.pathPerPage}&search=${encodeURIComponent(search)}`);
        state.paths = res.data;
        state.pathTotal = res.total;
        renderPathList();
        renderPathPagination();
    } catch (e) {
        toast(e.message, 'error');
    }
}

async function loadStats() {
    try {
        const stats = await api('/api/paths/stats');
        renderStats(stats);
    } catch (e) {
        // 忽略
    }
}

function renderStats(stats) {
    const staleWarning = stats.stale ? `
        <div class="stat-stale-warning">
            ⚠️ 路径数据已过期（点位或动线已变更），请重新生成 N×N 路径数据
        </div>
    ` : '';
    const html = `
        ${staleWarning}
        <div class="stat-card">
            <div class="stat-value">${stats.total.toLocaleString()}</div>
            <div class="stat-label">路径总数</div>
        </div>
        <div class="stat-grid">
            <div class="stat-card">
                <div class="stat-value" style="color:#3ecf8e">${stats.reachable.toLocaleString()}</div>
                <div class="stat-label">可达路径</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" style="color:#ef5b5b">${stats.unreachable.toLocaleString()}</div>
                <div class="stat-label">不可达路径</div>
            </div>
        </div>
        <div class="stat-grid">
            <div class="stat-card">
                <div class="stat-value" style="font-size:22px">${stats.avg_distance}</div>
                <div class="stat-label">平均距离(mm)</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" style="font-size:22px">${stats.max_distance}</div>
                <div class="stat-label">最大距离(mm)</div>
            </div>
        </div>
    `;
    document.getElementById('stats-content').innerHTML = html;
}

// ===== 数据加载 =====
async function loadAll() {
    await Promise.all([loadPoints(), loadLines(), loadSettings(), loadPointTypes()]);
    updateCounts();
    renderPointList();
    renderLineList();
    render();
}

async function loadPoints() {
    state.points = await api('/api/points');
}

async function loadLines() {
    state.lines = await api('/api/lines');
}

async function loadSettings() {
    state.settings = await api('/api/settings');
}

async function loadPointTypes() {
    const types = await api('/api/point-types');
    POINT_TYPES = {};
    for (const t of types) {
        POINT_TYPES[t.key] = { label: t.label, color: t.color, icon: t.icon, sort: t.sort };
    }
    renderPointTypePanel();
    updateAllTypeSelects();
}

function renderPointTypePanel() {
    const container = document.getElementById('point-type-list');
    if (!container) return;
    const currentSelected = getSelectedPointType();
    const html = Object.entries(POINT_TYPES).map(([key, cfg]) => `
        <label class="type-option">
            <input type="radio" name="point-type" value="${key}" ${key === currentSelected ? 'checked' : ''}>
            <span class="type-badge" style="background:${cfg.color};color:#fff;font-size:10px;padding:1px 6px">${cfg.label}</span>
        </label>
    `).join('');
    container.innerHTML = html;
}

function updateAllTypeSelects() {
    // 更新所有动态类型下拉框
    const options = Object.entries(POINT_TYPES).map(([key, cfg]) =>
        `<option value="${key}">${cfg.label}</option>`
    ).join('');
    ['aisle-start-type', 'aisle-end-type', 'aisle-pickup-type', 'edit-point-type'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            const current = el.value;
            el.innerHTML = options;
            // 尝试保持当前选择
            if (POINT_TYPES[current]) el.value = current;
        }
    });
}

// ===== 数据列表渲染 =====
function renderPointList() {
    const search = document.getElementById('point-search').value.toLowerCase();
    const filtered = state.points.filter(p => p.id.toLowerCase().includes(search));
    const html = filtered.map(p => {
        const cfg = POINT_TYPES[p.type] || { label: p.type, color: '#999' };
        return `
            <div class="data-item" onclick="focusPoint('${p.id}')">
                <div class="data-item-row">
                    <span class="data-item-id">${p.id}</span>
                    <div style="display:flex;gap:4px;align-items:center">
                        <span class="type-badge" style="background:${cfg.color};color:#fff;font-size:10px;padding:1px 6px">${cfg.label}</span>
                        <button class="delete-btn" onclick="event.stopPropagation();openEditPoint('${p.id}')" title="编辑">✏️</button>
                    </div>
                </div>
                <div class="data-item-meta">X: ${p.x}, Y: ${p.y}</div>
            </div>
        `;
    }).join('');
    document.getElementById('point-list').innerHTML = html || '<p class="placeholder-text">暂无点位</p>';
    document.getElementById('point-list-count').textContent = filtered.length;
}

function renderLineList() {
    const search = document.getElementById('line-search').value.toLowerCase();
    const filtered = state.lines.filter(l =>
        l.start_point_id.toLowerCase().includes(search) || l.end_point_id.toLowerCase().includes(search)
    );
    const html = filtered.map(l => `
        <div class="data-item" onclick="focusLine(${l.id})">
            <div class="data-item-row">
                <span class="data-item-id">${l.start_point_id} → ${l.end_point_id}</span>
                <button class="delete-btn" onclick="event.stopPropagation();deleteLine(${l.id})">×</button>
            </div>
            <div class="data-item-meta">距离: ${pxToMm(l.distance)} mm | 耗时: ${l.travel_time}s</div>
        </div>
    `).join('');
    document.getElementById('line-list').innerHTML = html || '<p class="placeholder-text">暂无动线</p>';
    document.getElementById('line-list-count').textContent = filtered.length;
}

function renderPathList() {
    const html = state.paths.map(p => {
        const route = p.route ? JSON.parse(p.route) : [];
        const routeStr = route.length > 3
            ? `${route[0]} → ... → ${route[route.length-1]}`
            : route.join(' → ');
        return `
            <div class="data-item">
                <div class="data-item-row">
                    <span class="data-item-id">${p.start_point_id} → ${p.end_point_id}</span>
                    <span class="data-item-meta">${p.distance < 0 ? '不可达' : pxToMm(p.distance) + ' mm'}</span>
                </div>
                <div class="data-item-meta">${p.distance < 0 ? '—' : '耗时 ' + p.travel_time + 's'}</div>
                <div class="data-item-meta" style="color:#6b7186;font-size:10px">${routeStr}</div>
            </div>
        `;
    }).join('');
    document.getElementById('path-list').innerHTML = html || '<p class="placeholder-text">暂无路径数据，请先生成</p>';
    document.getElementById('path-list-count').textContent = state.pathTotal;
    // 路径过期提示
    checkPathsStale();
}

async function checkPathsStale() {
    try {
        const stats = await api('/api/paths/stats');
        const existing = document.querySelector('.path-stale-banner');
        if (stats.stale) {
            if (!existing) {
                const banner = document.createElement('div');
                banner.className = 'path-stale-banner';
                banner.innerHTML = '⚠️ 路径数据已过期，<a href="javascript:generatePaths()">点击重新生成</a>';
                const pathList = document.getElementById('path-list');
                pathList.parentNode.insertBefore(banner, pathList);
            }
        } else if (existing) {
            existing.remove();
        }
    } catch (e) { /* 忽略 */ }
}

function renderPathPagination() {
    const totalPages = Math.ceil(state.pathTotal / state.pathPerPage);
    if (totalPages <= 1) {
        document.getElementById('path-pagination').innerHTML = '';
        return;
    }
    const cur = state.pathPage;
    let pages = [];
    if (totalPages <= 7) {
        for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
        pages = [1];
        if (cur > 3) pages.push('...');
        for (let i = Math.max(2, cur-1); i <= Math.min(totalPages-1, cur+1); i++) pages.push(i);
        if (cur < totalPages - 2) pages.push('...');
        pages.push(totalPages);
    }
    const html = pages.map(p => {
        if (p === '...') return '<span style="color:#6b7186">...</span>';
        return `<button class="page-btn ${p === cur ? 'active' : ''}" onclick="goToPathPage(${p})">${p}</button>`;
    }).join('');
    document.getElementById('path-pagination').innerHTML = html;
}

async function goToPathPage(page) {
    state.pathPage = page;
    await loadPaths();
}

// ===== Tab 切换 =====
function switchTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('active', content.id === `tab-${tab}`);
    });
    if (tab === 'paths' && state.paths.length === 0 && state.pathTotal > 0) {
        loadPaths();
    }
    if (tab === 'stats') {
        loadStats();
    }
}

// ===== 焦点定位 =====
function focusPoint(id) {
    const p = state.points.find(p => p.id === id);
    if (!p) return;
    // 居中到该点
    state.offsetX = canvasWidth / 2 - p.x * state.scale;
    state.offsetY = canvasHeight / 2 + p.y * state.scale;
    render();
}

function focusLine(id) {
    const ln = state.lines.find(l => l.id === id);
    if (!ln) return;
    const sp = state.points.find(p => p.id === ln.start_point_id);
    const ep = state.points.find(p => p.id === ln.end_point_id);
    if (!sp || !ep) return;
    const cx = (sp.x + ep.x) / 2;
    const cy = (sp.y + ep.y) / 2;
    state.offsetX = canvasWidth / 2 - cx * state.scale;
    state.offsetY = canvasHeight / 2 + cy * state.scale;
    state.selectedLine = ln;
    render();
}

// ===== 计数更新 =====
function updateCounts() {
    document.getElementById('point-count').textContent = state.points.length;
    document.getElementById('line-count').textContent = state.lines.length;
}

// ===== 设置 =====
function showSettings() {
    document.getElementById('setting-walk-speed').value = state.settings.walk_speed || '1.2';
    document.getElementById('setting-scale').value = state.settings.scale || '0.1';
    document.getElementById('setting-id-length').value = state.settings.id_length || '6';
    document.getElementById('settings-modal').style.display = '';
}

function hideSettings() {
    document.getElementById('settings-modal').style.display = 'none';
}

async function saveSettings() {
    const walkSpeed = document.getElementById('setting-walk-speed').value;
    const scale = document.getElementById('setting-scale').value;
    const idLength = document.getElementById('setting-id-length').value;
    showLoading('正在更新设置并刷新数据...');
    try {
        const result = await api('/api/settings', 'POST', { walk_speed: walkSpeed, scale: scale, id_length: idLength });
        state.settings.walk_speed = walkSpeed;
        state.settings.scale = scale;
        state.settings.id_length = idLength;
        hideSettings();
        // 全量刷新：动线耗时、路径耗时、统计都已按新比例重算
        await loadLines();
        if (state.pathTotal > 0) {
            await loadPaths();
            await loadStats();
        }
        renderLineList();
        renderPathList();
        render();
        hideLoading();
        const msg = result.recalculated
            ? '设置已保存，所有动线和路径数据已按新比例刷新'
            : '设置已保存';
        toast(msg, 'success');
    } catch (e) {
        hideLoading();
        toast(e.message, 'error');
    }
}

// ===== 导出 =====
function exportCSV(type) {
    const url = `/api/export/${type}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `${type}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast(`${type} 数据导出中...`, 'info');
}

function exportJSON() {
    fetch('/api/export/json')
        .then(r => r.json())
        .then(data => {
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `warehouse-config-${Date.now()}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            toast('JSON 配置已导出', 'success');
        });
}

function downloadDB() {
    const a = document.createElement('a');
    a.href = '/api/export/database';
    a.download = 'warehouse.db';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast('数据库文件下载中...', 'info');
}

function exportSVG() {
    if (state.points.length === 0) return toast('没有点位数据，无法导出', 'error');
    document.getElementById('svg-export-modal').style.display = 'flex';
}

function hideSVGExport() {
    document.getElementById('svg-export-modal').style.display = 'none';
}

function onTransparentToggle() {
    const transparent = document.getElementById('svg-transparent').checked;
    if (transparent) {
        document.getElementById('svg-grid').checked = false;
        document.getElementById('svg-legend').checked = false;
    }
}

function doExportSVG() {
    const transparent = document.getElementById('svg-transparent').checked;
    const labels = document.getElementById('svg-labels').checked;
    const grid = document.getElementById('svg-grid').checked;
    const legend = document.getElementById('svg-legend').checked;

    const params = new URLSearchParams();
    if (transparent) params.set('transparent', '1');
    if (!labels) params.set('labels', '0');
    if (grid) params.set('grid', '1');
    if (legend) params.set('legend', '1');

    const qs = params.toString();
    const a = document.createElement('a');
    a.href = '/api/export/svg' + (qs ? '?' + qs : '');
    a.download = `warehouse-map-${Date.now()}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    hideSVGExport();
    toast(transparent ? '透明背景矢量图导出中...' : '矢量图导出中...', 'info');
}

async function saveToServer() {
    toast('配置已保存在服务器数据库中', 'success');
}

// ===== 导入配置 =====
let _importData = null;

function showImportModal() {
    _importData = null;
    document.getElementById('import-file-input').value = '';
    document.getElementById('import-file-placeholder').style.display = '';
    document.getElementById('import-file-info').style.display = 'none';
    document.getElementById('import-preview').textContent = '请先选择文件';
    document.getElementById('import-confirm-btn').disabled = true;
    document.querySelector('input[name="import-mode"][value="replace"]').checked = true;
    document.getElementById('import-modal').style.display = '';
}

function hideImportModal() {
    document.getElementById('import-modal').style.display = 'none';
    _importData = null;
}

function handleImportFile(input) {
    const file = input.files[0];
    if (!file) return;

    document.getElementById('import-file-placeholder').style.display = 'none';
    document.getElementById('import-file-info').style.display = '';
    document.getElementById('import-file-name').textContent = file.name;
    document.getElementById('import-file-detail').textContent = `${(file.size / 1024).toFixed(1)} KB`;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            _importData = data;

            // 预览
            const pts = (data.points || []).length;
            const lns = (data.lines || []).length;
            const types = (data.point_types || []).length;
            const settings = Object.keys(data.settings || {}).length;
            const previewParts = [];
            if (pts) previewParts.push(`${pts} 个点位`);
            if (lns) previewParts.push(`${lns} 条动线`);
            if (types) previewParts.push(`${types} 个点位类型`);
            if (settings) previewParts.push(`${settings} 项设置`);
            document.getElementById('import-preview').innerHTML =
                previewParts.length > 0
                    ? `将导入：${previewParts.join('、')}`
                    : '<span style="color:#ef5b5b">文件中未检测到有效配置数据</span>';

            document.getElementById('import-confirm-btn').disabled = previewParts.length === 0;
        } catch (err) {
            document.getElementById('import-preview').innerHTML =
                `<span style="color:#ef5b5b">JSON 解析失败：${err.message}</span>`;
            document.getElementById('import-confirm-btn').disabled = true;
            _importData = null;
        }
    };
    reader.readAsText(file);
}

async function doImport() {
    if (!_importData) return;
    const mode = document.querySelector('input[name="import-mode"]:checked').value;

    const msg = mode === 'replace'
        ? '覆盖导入将清空当前所有数据，确认继续？'
        : '合并导入将保留现有数据并新增，确认继续？';
    if (!confirm(msg)) return;

    showLoading('正在导入配置...');
    try {
        const result = await api('/api/import', 'POST', { mode, data: _importData });
        hideImportModal();
        await loadAll();
        hideLoading();
        const s = result.stats;
        const parts = [];
        if (s.points) parts.push(`${s.points} 个点位`);
        if (s.lines) parts.push(`${s.lines} 条动线`);
        if (s.point_types) parts.push(`${s.point_types} 个类型`);
        if (s.settings) parts.push(`${s.settings} 项设置`);
        const summary = parts.length > 0 ? parts.join('、') : '无新数据';
        const skippedMsg = s.skipped > 0 ? `（跳过 ${s.skipped} 条）` : '';
        toast(`导入完成（${result.mode}）：${summary}${skippedMsg}`, 'success');
        fitToContent();
    } catch (e) {
        hideLoading();
        toast(e.message, 'error');
    }
}

// ===== 示例地图 =====
async function generateSample() {
    if (state.points.length > 0) {
        if (!confirm('当前已有数据，是否清空并生成示例？')) return;
    }
    showLoading('生成示例地图...');
    try {
        const sample = createSampleData();
        await api('/api/import', 'POST', sample);
        await loadAll();
        hideLoading();
        toast('示例地图已生成！点击「生成 N×N 路径数据」试试', 'success');
    } catch (e) {
        hideLoading();
        toast(e.message, 'error');
    }
}

function createSampleData() {
    // 构建一个仓库示例：入口 → 走廊 → 多排货架 → 集货区
    const points = [];
    const lines = [];
    const idLen = parseInt(state.settings.id_length) || 6;
    const pad = (n) => String(n).padStart(idLen, '0');

    // 出发点
    points.push({ id: 'START', x: 100, y: 400, type: 'start' });
    // 走廊岔路口
    points.push({ id: 'X1', x: 300, y: 400, type: 'intersection' });
    points.push({ id: 'X2', x: 500, y: 400, type: 'intersection' });
    points.push({ id: 'X3', x: 700, y: 400, type: 'intersection' });

    // A 排货架 (取货点)
    for (let i = 1; i <= 4; i++) {
        points.push({ id: `A${pad(i)}`, x: 300 + (i - 1) * 50, y: 250, type: 'pickup' });
    }
    // B 排货架
    for (let i = 1; i <= 4; i++) {
        points.push({ id: `B${pad(i)}`, x: 500 + (i - 1) * 50, y: 250, type: 'pickup' });
    }
    // C 排货架
    for (let i = 1; i <= 4; i++) {
        points.push({ id: `C${pad(i)}`, x: 300 + (i - 1) * 50, y: 550, type: 'pickup' });
    }
    // D 排货架
    for (let i = 1; i <= 4; i++) {
        points.push({ id: `D${pad(i)}`, x: 500 + (i - 1) * 50, y: 550, type: 'pickup' });
    }

    // 集货区（终止点）
    points.push({ id: 'END', x: 850, y: 400, type: 'end' });

    // 动线 - 主走廊
    lines.push({ start_point_id: 'START', end_point_id: 'X1' });
    lines.push({ start_point_id: 'X1', end_point_id: 'X2' });
    lines.push({ start_point_id: 'X2', end_point_id: 'X3' });
    lines.push({ start_point_id: 'X3', end_point_id: 'END' });

    // A 排通道
    lines.push({ start_point_id: 'X1', end_point_id: `A${pad(1)}` });
    for (let i = 1; i < 4; i++) {
        lines.push({ start_point_id: `A${pad(i)}`, end_point_id: `A${pad(i+1)}` });
    }
    lines.push({ start_point_id: `A${pad(4)}`, end_point_id: 'X2' });

    // B 排通道
    lines.push({ start_point_id: 'X2', end_point_id: `B${pad(1)}` });
    for (let i = 1; i < 4; i++) {
        lines.push({ start_point_id: `B${pad(i)}`, end_point_id: `B${pad(i+1)}` });
    }
    lines.push({ start_point_id: `B${pad(4)}`, end_point_id: 'X3' });

    // C 排通道
    lines.push({ start_point_id: 'X1', end_point_id: `C${pad(1)}` });
    for (let i = 1; i < 4; i++) {
        lines.push({ start_point_id: `C${pad(i)}`, end_point_id: `C${pad(i+1)}` });
    }
    lines.push({ start_point_id: `C${pad(4)}`, end_point_id: 'X2' });

    // D 排通道
    lines.push({ start_point_id: 'X2', end_point_id: `D${pad(1)}` });
    for (let i = 1; i < 4; i++) {
        lines.push({ start_point_id: `D${pad(i)}`, end_point_id: `D${pad(i+1)}` });
    }
    lines.push({ start_point_id: `D${pad(4)}`, end_point_id: 'X3' });

    return { points, lines, settings: state.settings };
}

// ===== 清空 =====
async function clearAll() {
    if (!confirm('确认清空所有点位、动线和路径数据？此操作不可恢复！')) return;
    // 逐个删除点位（会级联删除动线）
    const ids = state.points.map(p => p.id);
    for (const id of ids) {
        try {
            await api(`/api/points/${id}`, 'DELETE');
        } catch (e) { /* 忽略 */ }
    }
    state.points = [];
    state.lines = [];
    state.paths = [];
    state.pathTotal = 0;
    updateCounts();
    renderPointList();
    renderLineList();
    renderPathList();
    render();
    toast('已清空全部数据', 'info');
}

// ===== 视图控制 =====
function zoomIn() {
    const cx = canvasWidth / 2, cy = canvasHeight / 2;
    const worldBefore = screenToWorld(cx, cy);
    state.scale = Math.min(10, state.scale * 1.2);
    const worldAfter = screenToWorld(cx, cy);
    state.offsetX += (worldAfter.x - worldBefore.x) * state.scale;
    state.offsetY -= (worldAfter.y - worldBefore.y) * state.scale;
    render();
}

function zoomOut() {
    const cx = canvasWidth / 2, cy = canvasHeight / 2;
    const worldBefore = screenToWorld(cx, cy);
    state.scale = Math.max(0.1, state.scale / 1.2);
    const worldAfter = screenToWorld(cx, cy);
    state.offsetX += (worldAfter.x - worldBefore.x) * state.scale;
    state.offsetY -= (worldAfter.y - worldBefore.y) * state.scale;
    render();
}

function resetView() {
    state.scale = 1;
    state.offsetX = canvasWidth / 2;
    state.offsetY = canvasHeight / 2;
    render();
}

function toggleGrid() {
    state.showGrid = !state.showGrid;
    render();
}

function toggleLabels() {
    state.showLabels = !state.showLabels;
    render();
}

// ===== UI 工具 =====
function showLoading(msg) {
    document.getElementById('loading-text').textContent = msg;
    document.getElementById('loading-overlay').style.display = '';
}

function hideLoading() {
    document.getElementById('loading-overlay').style.display = 'none';
}

function toast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transition = 'opacity 0.3s';
        setTimeout(() => el.remove(), 300);
    }, 3000);
}

// ===== 初始化 =====
window.addEventListener('DOMContentLoaded', async () => {
    initCanvas();

    // ESC 取消拾取模式 / 关闭弹窗
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (state.aislePickTarget) {
                cancelAislePick();
            } else if (state.editingPoint) {
                closeEditPoint();
            } else {
                document.getElementById('settings-modal').style.display = 'none';
                document.getElementById('type-manager-modal').style.display = 'none';
                document.getElementById('svg-export-modal').style.display = 'none';
                document.getElementById('import-modal').style.display = 'none';
            }
        }
    });

    // 通道表单输入变化时刷新预览
    ['aisle-start-x', 'aisle-start-y', 'aisle-end-x', 'aisle-end-y', 'aisle-count'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', () => render());
    });

    await loadAll();
    // 如果没有数据，显示提示
    if (state.points.length === 0) {
        toast('点击左侧「生成示例地图」快速体验，或直接在画布上点击添加点位', 'info');
    }
});
