# Changelog

## 0.1.0-jdipper.10 — 18 November 2026

- Accept the dedicated `@jdipper/homebridge-fastwarm` provider alongside the existing Tuya provider through the same authenticated private IPC contract. Preserve logical room IDs, saved profiles, history and enrollment.
- Bind prepared operations to the provider package identity as well as its instance, process and token, so a provider replacement invalidates older previews.
- Preserve Hive behavior, Tuya cloud API optimisations, and the grouped Home/Holiday accessory.
- Use FastWarm connection labels for API usage and refresh the editor asset version.
- Make the legacy compatibility test portable with only the unchanged, hash-pinned read-only validator fixture; no frozen execution or request code is included.

This release has completed a backed-up provider migration and read-only verification with FastWarm `.1`. It has not been published to npm.
