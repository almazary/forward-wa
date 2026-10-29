module.exports = {
  apps: [
    {
      name: 'forward-wa',
      script: 'dist/index.js',
      restart_delay: 5000,
      max_restarts: 10,
      // Safety net: normal usage is ~150 MB, so restart cleanly before the heap runs away
      max_memory_restart: '300M',
      time: true,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
}
