
## 08:57 | docs/live-activities-prompt
Diagnosed and fixed `server-bind-retry` flake (#295): warm-up scan takes 20–34s under load, blows 15s timeout; added `skipStartupWarmup` flag to `ServerConfig` (default false), reducing test time 18.4s → 3.2s and passing 5/5 at load 696; also committed `.env` support for prod (#294) with team/bundle from env file and key from `.p8`.