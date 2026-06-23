const data = require('C:/tmp/copilot-debug8/copilot-bad-response.json');
console.log('ai-message:', data.rawHtml.includes('ai-message'));
console.log('Stop:', data.rawHtml.includes('Stop responding'));
console.log('count:', (data.rawHtml.match(/data-content="ai-message"/g) || []).length);
