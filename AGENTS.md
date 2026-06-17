# Repository Instructions

## Single-Run Options

When the user gives run-specific wording or says "single run instructions", treat those instructions as one-off parameters for the current invocation only. Do not edit persistent repo configuration, defaults, docs, package metadata, or checked-in settings unless the user explicitly says the request is a configuration change or asks for persistent behavior.

Examples of one-off run parameters:

- "no VPN" means do not require or enforce VPN handling for that run; it does not imply changing VPN-related defaults.
- "one mode", "dark mode", or "no light/dark mode" means use only the requested mode for that run; it does not imply changing the tool's default light/dark configuration.
- Limits, toggles, skips, modes, and environment preferences should generally be passed as CLI flags, command parameters, or runtime choices rather than written into the repository.

If the request is ambiguous, prefer the single-run interpretation and only ask for clarification when making the change persistent would be necessary to proceed.
