#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const os = require('os');
const deploy = require('../deploy-plugin.js');

const pluginId = 'claude-agent'; // Stable Obsidian identity for upgrade compatibility.
const includeDeps = process.argv.includes('--deps');
if (includeDeps) console.log('Including server/node_modules\n');

// The shared deploy helper dereferences pnpm symlinks into a flat dependency
// tree. Executable shims and pnpm's virtual-store metadata are not required at
// runtime; omitting them also prevents stale/dangling .bin links from breaking
// deployment after a dependency is removed.
const dependencyCopySkips = ['.bin', '.modules.yaml', '.pnpm', '.pnpm-workspace-state-v1.json'];

if (includeDeps) {
    // A dependency deployment is a complete bridge-server replacement. The
    // shared copier merges directories, so clean the target first to ensure
    // removed routes and packages from older backends do not survive.
    const vaultRoot = fs.realpathSync(path.join(os.homedir(), 'lifeos'));
    const deployedServer = path.join(vaultRoot, '.obsidian', 'plugins', pluginId, 'server');
    fs.rmSync(deployedServer, { recursive: true, force: true });
}

deploy({
    pluginId,
    files: [
        { name: 'main.js',       from: path.join(__dirname, 'dist', 'main.js') },
        { name: 'manifest.json', from: path.join(__dirname, 'manifest.json') },
        { name: 'styles.css',    from: path.join(__dirname, 'dist', 'styles.css') },
    ],
    mobile: {},
    dirs: [{
        name: 'server',
        from: path.join(__dirname, 'server'),
        skipNames: includeDeps ? dependencyCopySkips : ['node_modules'],
    }],
});
