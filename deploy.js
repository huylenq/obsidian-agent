#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Flags
const includeDeps = process.argv.includes('--deps');

// Configuration
const PLUGIN_ID = 'claude-agent';
const IWE_PATH = '/Users/huy/Library/Mobile Documents/iCloud~md~obsidian/Documents/IWE';
const IWE_PLUGIN_PATH = path.join(IWE_PATH, '.obsidian/plugins', PLUGIN_ID);
const IWE_MOBILE_PLUGIN_PATH = path.join(IWE_PATH, '.obsidian-mobile/plugins', PLUGIN_ID);

// Files to deploy
const FILES_TO_DEPLOY = [
    'main.js',
    'manifest.json',
    'styles.css'
];

// Directories to deploy (recursive copy)
const DIRS_TO_DEPLOY = [
    'server'
];

// Ensure target directories exist
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Created directory: ${dir}`);
    }
}

// Recursively copy a directory, skipping entries in skipNames
function copyDirRecursive(src, dest, skipNames = []) {
    ensureDir(dest);
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
        if (skipNames.includes(entry.name)) continue;
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath, skipNames);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

// Copy files to target directory
function deployToDirectory(targetDir, { includeDirs = true } = {}) {
    ensureDir(targetDir);

    FILES_TO_DEPLOY.forEach(file => {
        const sourcePath = path.join(__dirname, file);
        const targetPath = path.join(targetDir, file);

        if (fs.existsSync(sourcePath)) {
            fs.copyFileSync(sourcePath, targetPath);
            console.log(`Deployed ${file} to ${targetPath}`);
        } else {
            console.warn(`Warning: ${file} not found in build directory`);
        }
    });

    // Deploy directories (skipped for mobile — no Node.js runtime)
    if (includeDirs) {
        const skipNames = includeDeps ? [] : ['node_modules'];
        DIRS_TO_DEPLOY.forEach(dir => {
            const sourcePath = path.join(__dirname, dir);
            const targetPath = path.join(targetDir, dir);

            if (fs.existsSync(sourcePath)) {
                copyDirRecursive(sourcePath, targetPath, skipNames);
                console.log(`Deployed ${dir}/ to ${targetPath}${skipNames.length ? ' (skipping node_modules)' : ''}`);
            } else {
                console.warn(`Warning: ${dir}/ not found in build directory`);
            }
        });
    }
}

// Main deployment
console.log(`Starting deployment of claude-agent plugin...${includeDeps ? ' (with node_modules)' : ' (without node_modules, use --deps to include)'}\n`);

// Deploy to .obsidian (desktop)
console.log('Deploying to .obsidian (desktop):');
deployToDirectory(IWE_PLUGIN_PATH);

// Deploy to .obsidian-mobile (mobile — files only, no server dir)
console.log('\nDeploying to .obsidian-mobile (mobile):');
deployToDirectory(IWE_MOBILE_PLUGIN_PATH, { includeDirs: false });

console.log('\nDeployment complete!');
console.log('Remember to reload Obsidian to see the changes.');
