const fs = require('fs');
let code = fs.readFileSync('src/index.ts', 'utf-8');

// Replace ctx.reply with editMessageText
code = code.replace(
  /const statusMsg = await ctx\.reply\((['`])(.*?)\1, \{ parse_mode: 'MarkdownV2' \}\);/g,
  "await ctx.editMessageText($1$2$1, { parse_mode: 'MarkdownV2' }).catch(() => {});"
);

// Replace ctx.api.editMessageText with editMessageText
code = code.replace(
  /await ctx\.api\.editMessageText\(ctx\.chat!\.id, statusMsg\.message_id, (.*?)\);/g,
  "await ctx.editMessageText($1).catch(() => {});"
);

fs.writeFileSync('src/index.ts', code);
console.log('Replaced successfully.');
