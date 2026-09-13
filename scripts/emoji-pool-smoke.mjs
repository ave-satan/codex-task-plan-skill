import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../companion/main.swift', import.meta.url), 'utf8');
const block = source.match(/private let planEmojiPool = \[([\s\S]*?)\n\]/)?.[1];
assert.ok(block, 'planEmojiPool must be present in companion/main.swift');

const emoji = [...block.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)]
  .map((match) => JSON.parse(`"${match[1]}"`));

assert.equal(emoji.length, 150, 'pool must contain exactly 150 emoji');
assert.equal(new Set(emoji).size, 150, 'every plan emoji must be unique');

for (const required of ['🫠', '🤪', '🤡', '💩', '👹', '🦧', '🪿', '🪳', '🧌', '🗿', '🛸', '🪠', '🍆', '🫙']) {
  assert.ok(emoji.includes(required), `missing chaos emoji ${required}`);
}

for (const boring of ['📁', '💡', '🚀', '✅', '📌', '🏆', '👑']) {
  assert.ok(!emoji.includes(boring), `boring emoji slipped back in: ${boring}`);
}

console.log(`emoji-pool-smoke: ok (${emoji.length} unique chaos emoji)`);
