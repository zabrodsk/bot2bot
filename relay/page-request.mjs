import { AsyncLocalStorage } from 'node:async_hooks';

// HEAD uses the page router's GET checks, without the writes made while rendering a page.
export const pageRequest = new AsyncLocalStorage();
export const isHeadPage = () => pageRequest.getStore() === 'HEAD';
