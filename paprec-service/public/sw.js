'use strict';
self.addEventListener('push',event=>{
  let data={};
  try{data=event.data?event.data.json():{};}catch{data={};}
  const title=String(data.title||'MarkNet Serwis').slice(0,90);
  const options={
    body:String(data.body||'Nowe zdarzenie serwisowe').slice(0,180),
    tag:String(data.tag||'marknet-service').slice(0,90),
    icon:'/serwis/marknet-icon-192.png',
    badge:'/serwis/marknet-icon-192.png',
    data:{url:'/serwis/'},
    renotify:Boolean(data.critical)
  };
  event.waitUntil(self.registration.showNotification(title,options));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const url=new URL('/serwis/',self.location.origin).href;
    const clientsList=await clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of clientsList)if(client.url.startsWith(url)){await client.focus();return;}
    await clients.openWindow(url);
  })());
});