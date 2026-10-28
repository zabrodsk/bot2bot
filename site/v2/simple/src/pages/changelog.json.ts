// The changelog as data, for the dashboard's "What's new" note after an update.
import log from '../data/changelog.json';

export const GET = () => new Response(JSON.stringify(log), { headers: { 'content-type': 'application/json; charset=utf-8' } });
