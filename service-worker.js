const CACHE_NAME='connectplus-launcher-v5';
const APP_SHELL=[
  '/connectplus-site/app/',
  '/connectplus-site/app/index.html',
  '/connectplus-site/app/app.css',
  '/connectplus-site/app/app.js',
  '/connectplus-site/app/manifest.webmanifest',
  '/connectplus-site/app/icons/connectplus-app-192-v4.png',
  '/connectplus-site/app/icons/connectplus-app-512-v4.png',
  '/connectplus-site/app/icons/connectplus-app-maskable-512-v4.png'
];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('connectplus-launcher-')&&key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const request=event.request;
  const url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin||!APP_SHELL.includes(url.pathname))return;
  event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{
    if(response.ok){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(request,copy));}
    return response;
  })));
});