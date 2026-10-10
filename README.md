# DSH Session Bridge

Install: `dsh plugin --profile web add github:Ozqi/dsh-session-bridge`

This Web-profile plugin provides the three `session_bridge_*` tools and a small `dsh-agent-trigger` timer.

`config.triggers` accepts daily wake-up entries with `id`, `sessionId`, `hour`, `minute`, `timeZone`, and `prompt`. At the configured local time, the plugin resumes the target Session when needed and queues the prompt with `source.plugin` set to `dsh-agent-trigger:<id>`. The target Agent decides the requested action, including creating a new Session.

The timer is process-local. DSH Web must be running at the due time; missed runs are not replayed. Each successful or failed delivery is logged. Reload or disposal clears the old timer before installing the new configuration.
