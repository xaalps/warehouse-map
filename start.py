"""
仓内地图数据采集系统 - 启动脚本
"""
import subprocess
import sys
import os

# 定位 Python 解释器和虚拟环境
VENV_PYTHON = r"C:\Users\Administrator\.workbuddy\binaries\python\envs\warehouse\Scripts\python.exe"
APP_DIR = os.path.dirname(os.path.abspath(__file__))

if __name__ == '__main__':
    os.chdir(APP_DIR)
    subprocess.run([VENV_PYTHON, os.path.join(APP_DIR, 'app.py')])
