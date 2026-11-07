[简体中文](GUIDE.zh-CN.md) | **English**

# Usage, Configuration and Development

[Back to the project](../README.en.md)

## Quick start

Open the website and start training. Add it to your phone's home screen for offline use. You can also open `index.html` directly; full local PWA behavior requires localhost or HTTPS hosting.

Set your daily new-word quota and retention target, then start a session. Recall the meaning before revealing choices; use `1`–`4` to answer and `Enter` to continue. Spelling hides the first-letter hint by default and requires correction after a mistake.

## Usage

**Learning rules:** FSRS-6 uses the bundled `ts-fsrs 5.4.2`. Target retention defaults to 90%, adjustable from 80–95%; it is a model target, not guaranteed accuracy. Promotion defaults to independent correct answers on 3 different days, plus stability of 7 days for recognition or 21 for spelling. These are this app's thresholds, not FSRS or Anki defaults.

**Daily word preparation:** the current `meta.dailyWordTarget: 80` enables a server task at 06:00 Beijing time. It fills the gap after counting today's practiced words, currently due words and unseen stock. It does not require learning 80 words every day. Insufficient source material leaves a reported shortfall; unsynced offline practice cannot be counted. See the detailed reference for the older candidate mode and server setup.

**Device synchronization:** create a separate private repository. On each device, enter its owner, repository, file path (default `progress.json`) and a fine-grained token granting Contents read/write only to that repository. Tokens remain in that browser's `localStorage` and are sent only to GitHub's API; never place them in the public vocabulary repository. Test Connection checks access, branch and file permissions.

Per-word state uses the latest practice time. Correct/wrong counts use the maximum rather than a sum; learning settings use the newer compatible version, while pronunciation remains device-specific. Concurrent writes reread and merge for up to 3 attempts. Fully offline devices cannot share a real-time daily quota.

**Progress protection:** storage remains `worddrill.v1`. The v6 migration preserves prior fields and FSRS state, backing up first to `worddrill.backup.before-v6`; older v5 backups remain. Corrupt or newer-version data is not blindly overwritten. Export before upgrading and refresh every device before syncing. Clearing site data removes progress and tokens; Clear Credentials removes only this device's sync configuration.

## Development and checks

Learning checks require **Node.js 20+**, with no dependency installation:

```bash
node scripts/check-learning.cjs
```

FlowUs synchronization and word import use Python 3. Preview before modifying files:

```bash
python3 scripts/sync-from-flowus.py --dry-run
python3 scripts/add-words.py --list words.txt --dry-run
python3 scripts/check-cet.py
```

Actual word-import runs may commit and push automatically. Use `--no-commit` for file-only changes and read the full reference first. Word IDs must remain stable; changing an ID creates a new word. Configure timers, private-progress reads and publication keys separately, and avoid running two word-preparation schedulers simultaneously.

## Documentation and support

- [Synchronization, migration, vocabulary, icons and scheduled preparation (Chinese)](../docs/readme-reference.zh-CN.md)
- [Learning research, exam requirements and evidence limits (Chinese)](../docs/learning-upgrade.md)
- [Report an issue](https://github.com/DrivingGodJ/word-drill/issues)

## License and credits

No standalone repository-wide license is declared. Bundled ts-fsrs in `vendor/` retains its MIT license. Dictionaries, frequencies and example sentences have separate sources; a dependency's license does not license the entire repository or all learning data.
