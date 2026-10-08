#!/usr/bin/env python3
"""安装本机每日 9 点补词任务；安装本身不运行补词、不改词库。

python3 scripts/install-cet-timer.py --repo /path/to/clean/main/checkout
--preview 安装只预演的任务，可 kickstart 验证后再次安装正常任务。
运行代码用固定副本；以后修改补词脚本后重新运行本安装器即可更新。
"""
import argparse
import hashlib
import os
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path

LABEL = 'com.drivinggodj.worddrill.cet'


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--repo', type=Path, required=True)
    ap.add_argument('--preview', action='store_true')
    args = ap.parse_args()
    if sys.platform != 'darwin':
        ap.error('本安装器使用 macOS launchd。其它系统可直接定时调用 add-cet-words.py。')
    repo = args.repo.expanduser().resolve()
    source = Path(__file__).with_name('add-cet-words.py')
    gh = shutil.which('gh')
    if not gh:
        ap.error('未找到 gh，请先安装并登录 GitHub CLI。')
    for command, expected in [(['git', '-C', str(repo), 'branch', '--show-current'], 'main'),
                              (['git', '-C', str(repo), 'status', '--porcelain'], '')]:
        if subprocess.check_output(command, text=True).strip() != expected:
            ap.error('定时任务必须使用干净的 main 工作副本，不能指向开发分支。')
    root = Path.home() / 'Library/Application Support/WordDrill/cet'
    log = Path.home() / 'Library/Logs/WordDrill'
    plist = Path.home() / 'Library/LaunchAgents' / f'{LABEL}.plist'
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    log.mkdir(parents=True, exist_ok=True, mode=0o700)
    plist.parent.mkdir(parents=True, exist_ok=True)
    installed = root / source.name
    payload = source.read_bytes()
    compile(payload, str(installed), 'exec')
    config = {'Label': LABEL, 'ProgramArguments': ['/usr/bin/python3', str(installed), '--repo', str(repo)],
              'WorkingDirectory': str(repo), 'StartCalendarInterval': {'Hour': 9, 'Minute': 0},
              'RunAtLoad': False, 'ProcessType': 'Background',
              'EnvironmentVariables': {'PATH': f'{Path(gh).parent}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
                                       'PYTHONUNBUFFERED': '1'},
              'StandardOutPath': str(log / 'cet.log'), 'StandardErrorPath': str(log / 'cet-error.log')}
    if args.preview:
        config['ProgramArguments'].append('--dry-run')
    # 保留上一个安装版本，失败可恢复；只操作这个任务，不碰其它 LaunchAgent。
    for path in (installed, plist):
        if path.exists():
            shutil.copy2(path, root / f'{path.name}.previous')
    domain = f'gui/{os.getuid()}'
    existing = subprocess.run(['launchctl', 'print', f'{domain}/{LABEL}'], capture_output=True).returncode == 0
    if existing:
        subprocess.run(['launchctl', 'bootout', f'{domain}/{LABEL}'], check=True)
    try:
        installed.write_bytes(payload)
        installed.chmod(0o700)
        with plist.open('wb') as f:
            plistlib.dump(config, f)
        subprocess.run(['plutil', '-lint', str(plist)], check=True)
        subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True)
    except Exception:
        for path in (installed, plist):
            previous = root / f'{path.name}.previous'
            if previous.exists():
                shutil.copy2(previous, path)
            else:
                path.unlink(missing_ok=True)
        if existing and plist.exists():
            subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True)
        raise
    print(f'已安装 {LABEL}，每天 9 点，休眠错过的任务在唤醒后合并执行一次。')
    print('模式：' + ('仅预演' if args.preview else '处理已确认词与新候选'))
    print(f'补词代码 SHA-256：{hashlib.sha256(payload).hexdigest()}')
    print(f'配置：{plist}\n日志：{log}')


if __name__ == '__main__':
    main()
