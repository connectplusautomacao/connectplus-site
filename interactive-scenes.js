(function(){
  const scenes={
    cheguei:{label:'Cheguei em casa',file:'cena-cheguei.webp',alt:'Sala sofisticada ao entardecer, com cortinas abertas e iluminação acolhedora',kicker:'Quando você chega',title:'Bem-vindo de volta.',copy:'A casa abre as cortinas e prepara a iluminação para receber você.',description:'Um ambiente acolhedor pronto para você.',controls:[['Iluminação','ambiente acolhedor'],['Cortinas','abertas'],['Climatização','confortável'],['Som','sua trilha favorita']]},
    cinema:{label:'Modo cinema',file:'cena-cinema.webp',alt:'Sala de cinema residencial com cortinas fechadas, televisão ligada e luz suave',kicker:'Hora de relaxar',title:'A sessão vai começar.',copy:'As cortinas fecham, as luzes diminuem e o som cria o clima.',description:'Tudo pronto para curtir seu filme.',controls:[['Iluminação','luz suave'],['Cortinas','fechadas'],['Som','imersivo'],['TV','pronta para assistir']]},
    noite:{label:'Boa noite',file:'cena-boa-noite.webp',alt:'Sala tranquila à noite com iluminação indireta e cortinas fechadas',kicker:'Uma rotina tranquila',title:'Desacelere com conforto.',copy:'A casa ajusta as luzes e fecha o ambiente para o descanso.',description:'Uma rotina noturna mais simples e confortável.',controls:[['Iluminação','modo noturno'],['Cortinas','fechadas'],['Fechaduras','verificadas'],['Ambientes','em descanso']]},
    viajar:{label:'Vou viajar',file:'cena-viajar.webp',alt:'Sala iluminada durante o dia, com câmera discreta e cortinas em modo privacidade',kicker:'Sua casa em segurança',title:'Pode viajar tranquilo.',copy:'A rotina de ausência ajuda a cuidar do ambiente enquanto você está fora.',description:'Mais tranquilidade mesmo longe de casa.',controls:[['Câmeras','prontas para monitorar'],['Cortinas','modo privacidade'],['Iluminação','programada'],['Acessos','sob controle']]}
  };
  const root=document.querySelector('.cp-scenes');
  if(!root)return;
  const buttons=[...root.querySelectorAll('.cp-scene-button')];
  let activePhoto=root.querySelector('#cp-scene-photo-a');
  let otherPhoto=root.querySelector('#cp-scene-photo-b');
  let activeKey=null;
  let imageRequest=0;
  function renderScene(key){
    const scene=scenes[key];
    if(!scene||key===activeKey)return;
    activeKey=key;
    buttons.forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.scene===key)));
    root.querySelector('#cp-scene-counter').textContent=`CENA ${String(buttons.findIndex(button=>button.dataset.scene===key)+1).padStart(2,'0')} / 04`;
    root.querySelector('#cp-scene-kicker').textContent=scene.kicker;
    root.querySelector('#cp-scene-title').textContent=scene.title;
    root.querySelector('#cp-scene-copy').textContent=scene.copy;
    root.querySelector('#cp-scene-label').textContent=scene.label;
    root.querySelector('#cp-scene-description').textContent=scene.description;
    const list=root.querySelector('#cp-scene-controls');
    list.replaceChildren(...scene.controls.map(([label,state])=>{const item=document.createElement('li');const name=document.createElement('span');name.textContent=label;const value=document.createElement('span');value.textContent=state;item.append(name,value);return item;}));
    const message=`Olá! Quero conversar sobre um projeto de automação residencial para a cena ${scene.label}.`;
    root.querySelector('#cp-scene-cta').href=`https://wa.me/5571993342920?text=${encodeURIComponent(message)}`;
    const request=++imageRequest;
    otherPhoto.alt=scene.alt;
    otherPhoto.onload=()=>{if(request!==imageRequest)return;otherPhoto.classList.add('is-active');activePhoto.classList.remove('is-active');[activePhoto,otherPhoto]=[otherPhoto,activePhoto];};
    otherPhoto.onerror=()=>{if(request===imageRequest){otherPhoto.classList.remove('is-active');}};
    otherPhoto.src=scene.file;
  }
  buttons.forEach(button=>button.addEventListener('click',()=>renderScene(button.dataset.scene)));
  renderScene('cheguei');
  Object.values(scenes).forEach(scene=>{const image=new Image();image.src=scene.file;});
})();
