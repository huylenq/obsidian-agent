#!/usr/bin/env node

const path = require('path');
const deploy = require('../deploy-plugin.js');

const includeDeps = process.argv.includes('--deps');
if (includeDeps) console.log('Including server/node_modules\n');

deploy({
    pluginId: 'claude-agent',
    files: [
        { name: 'main.js',       from: path.join(__dirname, 'dist', 'main.js') },
        { name: 'manifest.json', from: path.join(__dirname, 'manifest.json') },
        { name: 'styles.css',    from: path.join(__dirname, 'dist', 'styles.css') },
    ],
    mobile: {},
    dirs: [{
        name: 'server',
        from: path.join(__dirname, 'server'),
        skipNames: includeDeps ? [] : ['node_modules'],
    }],
});
