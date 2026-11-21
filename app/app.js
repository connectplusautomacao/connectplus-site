let installPrompt;
const installButton=document.querySelector('#installButton');
const installHint=document.querySelector('#installHint');
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;installButton.hidden=false;installHint.hidden=true;});
installButton.addEventListener('click',async()=>{if(!installPrompt)return;installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;installButton.hidden=true;});
window.addEventListener('appinstalled',()=>{installButton.hidden=true;installHint.hidden=true;});
if('serviceWorker' in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('../service-worker.js',{scope:'../'}).catch(()=>{}));}