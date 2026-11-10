// Quick diagnostic: run `node forum_check.js` on the same machine/host as the bot.
// It reads the newest POTD forum page and prints what the parser finds.
const { fetchLatestForumPage, parsePOTDFromTemplate } = require('./potdmonitor');

(async () => {
    try {
        const page = await fetchLatestForumPage();
        console.log('Newest page:', page.page);
        console.log('URL:', page.url);

        const result = parsePOTDFromTemplate(page.text);
        console.log('POTD :', result.potd || '(not found yet)');
        console.log('PPOTD:', result.ppotd || '(not found yet)');
        console.log('Entries in newest template:', result.entries);
    } catch (error) {
        console.error('FAILED:', error.message);
        process.exit(1);
    }
})();
