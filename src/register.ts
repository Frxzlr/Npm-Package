/**
 * Side-effect entry point: `node --import whycrash/register app.js`
 * (or `node -r whycrash/register app.js`, or `import 'whycrash/register'`).
 */
import { register } from './hook.js';

register();

export { register };
