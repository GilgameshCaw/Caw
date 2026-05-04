module.exports = {
  "apps": [
    {
      "name": "caw-server",
      "cwd": "/home/jaysouth/apps/Caw/client",
      "script": "node",
      "args": "-r ./file-polyfill.js -r tsx/cjs programs/start.ts",
      "env": {
        "NODE_ENV": "production"
      },
      "max_memory_restart": "1G",
      "error_file": "/home/jaysouth/apps/Caw/logs/caw-server-error.log",
      "out_file": "/home/jaysouth/apps/Caw/logs/caw-server-out.log",
      "merge_logs": true,
      "log_date_format": "YYYY-MM-DD HH:mm:ss Z"
    },
    {
      "name": "caw-frontend",
      "cwd": "/home/jaysouth/apps/Caw/client/src/services/FrontEnd",
      "script": "npx",
      "args": "vite --host 0.0.0.0",
      "env": {
        "NODE_ENV": "development"
      },
      "error_file": "/home/jaysouth/apps/Caw/logs/caw-frontend-error.log",
      "out_file": "/home/jaysouth/apps/Caw/logs/caw-frontend-out.log",
      "merge_logs": true,
      "log_date_format": "YYYY-MM-DD HH:mm:ss Z"
    }
  ]
}
