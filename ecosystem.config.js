/**
 * PM2 ECOSYSTEM CONFIGURATION
 * ============================================================
 * PM2 is the process manager that keeps Node.js alive in production.
 * It handles clustering, automatic restarts, log rotation, and
 * zero-downtime reloads.
 *
 * Commands:
 *   pm2 start ecosystem.config.js --env production   # First start
 *   pm2 reload ecosystem.config.js --env production  # Zero-downtime reload
 *   pm2 stop    ezone-api                            # Stop
 *   pm2 delete  ezone-api                            # Remove from PM2
 *   pm2 logs    ezone-api                            # Tail logs
 *   pm2 status                                       # List processes
 *   pm2 monit                                        # Real-time dashboard
 *   pm2 startup                                      # Auto-start on reboot
 *   pm2 save                                         # Save process list for startup
 * ============================================================
 */

module.exports = {
  apps: [
    {
      // ── Identity ────────────────────────────────────────────
      name:   'ezone-api',
      script: './server.js',

      // ── Cluster mode ────────────────────────────────────────
      // 'max' = one worker process per CPU core.
      // Cluster mode lets Node.js use multiple cores (Node is single-threaded
      // per process), multiplying throughput for CPU-bound work.
      // For a 2-core VPS this gives 2 workers; 4-core gives 4 workers.
      instances: 'max',
      exec_mode: 'cluster',

      // ── File watching ───────────────────────────────────────
      // NEVER enable file watching in production — it causes restarts on
      // every deployment file write, breaking in-flight requests.
      watch: false,

      // ── Memory protection ───────────────────────────────────
      // Restart the process if it exceeds 500 MB. This is a safety net for
      // memory leaks that might otherwise grow until the VPS OOM-kills Node.
      max_memory_restart: '500M',

      // ── Environment variables ────────────────────────────────
      // 'env' block is the fallback used when no --env flag is given.
      // 'env_production' is activated with: pm2 start ... --env production
      env: {
        NODE_ENV: 'development',
        PORT: 5000
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 5000
        // All secrets (DB_PASSWORD, JWT_SECRET, etc.) are read from the .env
        // file via dotenv. Do NOT hardcode them here — this file is in git.
      },

      // ── Logging ─────────────────────────────────────────────
      // Separate out-file and error-file make it easy to grep only errors.
      // merge_logs combines output from all cluster workers into one file.
      out_file:        './logs/out.log',
      error_file:      './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs:      true,

      // ── Restart policy ──────────────────────────────────────
      autorestart:   true,
      restart_delay: 2000,    // Wait 2 s between crash→restart cycles
      max_restarts:  10,      // After 10 restarts in quick succession, give up
                              // (prevents infinite restart loops eating CPU)
      min_uptime:    '10s',   // App must stay alive 10 s to count as a
                              // successful start (avoids counting crash loops)

      // ── Graceful shutdown ────────────────────────────────────
      // Time PM2 waits for the app's SIGTERM handler (server.close()) to
      // finish before sending SIGKILL. Must be > the app's own 10 s timeout.
      kill_timeout:   12000,

      // ── Source maps ─────────────────────────────────────────
      // Translates minified/compiled stack traces back to source lines.
      source_map_support: true
    }
  ]
};
