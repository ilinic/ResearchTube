import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'agent', 'custom-tools', 'custom-toolset', 'manifest.json'), 'utf8'));

assert.equal(manifest.groupTitle, 'Custom Toolset');
assert.deepEqual(manifest.tools.map(tool => tool.name), ['count_words', 'wait_seconds']);
assert.equal(manifest.tools[0].execution, 'sync');
assert.equal(manifest.tools[1].execution, 'task');
assert.match(background, /refreshCustomToolDefinitions/);
assert.match(background, /name: "custom_tool_status"/);
assert.match(background, /name: "custom_tool_cancel"/);
assert.match(background, /customToolByName\(name\)/);
console.log('Custom Tools: manifest package, sync/async examples and MCP lifecycle wiring passed');
