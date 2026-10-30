function enviarWhatsApp(e) {
  e.preventDefault();

  const nome = document.getElementById('nome').value;
  const telefone = document.getElementById('telefone').value;
  const email = document.getElementById('email').value;
  const imovel = document.getElementById('imovel').value;
  const mensagem = document.getElementById('mensagem').value;

  const texto = `Olá! Meu nome é ${nome}. WhatsApp: ${telefone}. E-mail: ${email}. Tipo de imóvel: ${imovel}. ${mensagem}`;

  // Registra a conversão no Google Ads
  if (typeof gtag_report_conversion === 'function') {
    gtag_report_conversion();
  }

  // Abre o WhatsApp da Connect Plus
  window.open(
    'https://wa.me/5571993342920?text=' + encodeURIComponent(texto),
    '_blank'
  );

  return false;
}


/* =========================================
   ASSISTENTE VIRTUAL CONNECT PLUS
   ========================================= */

(function () {
  const botao = document.getElementById('cp-chat-toggle');
  const janela = document.getElementById('cp-chat-window');
  const fechar = document.getElementById('cp-chat-close');
  const resposta = document.getElementById('cp-chat-response');

  if (!botao || !janela || !fechar || !resposta) return;

  const whatsapp = 'https://wa.me/5571993342920';

  const respostas = {
    servicos: {
      texto: '🏠 Trabalhamos com iluminação inteligente, sonorização residencial, cortinas automatizadas, fechaduras digitais, redes Wi-Fi e controle por voz com Alexa.',
      link: '#solucoes',
      botao: 'Conhecer soluções'
    },

    automacao: {
      texto: '💡 A automação residencial permite controlar iluminação, cortinas, som e outros dispositivos de forma prática, inclusive pelo celular ou por comandos de voz. As possibilidades dependem da infraestrutura do imóvel.',
      link: '#solucoes',
      botao: 'Ver nossos serviços'
    },

    orcamento: {
      texto: '💰 Será um prazer preparar seu orçamento! Nossa equipe pode conhecer suas necessidades e orientar sobre as melhores soluções para sua residência.',
      link: whatsapp + '?text=' + encodeURIComponent(
        'Olá! Gostaria de solicitar um orçamento de automação residencial.'
      ),
      botao: 'Solicitar orçamento pelo WhatsApp'
    },

    parcerias: {
      texto: '🤝 A Connect Plus desenvolve parcerias com arquitetos, designers de interiores e corretores de imóveis. Entre em contato para conhecer as possibilidades.',
      link: whatsapp + '?text=' + encodeURIComponent(
        'Olá! Gostaria de conhecer o programa de parcerias da Connect Plus.'
      ),
      botao: 'Conversar sobre parcerias'
    },

    especialista: {
      texto: '📲 Nossa equipe está pronta para ajudar você com seu projeto de automação residencial.',
      link: whatsapp + '?text=' + encodeURIComponent(
        'Olá! Gostaria de falar com um especialista da Connect Plus.'
      ),
      botao: 'Falar pelo WhatsApp'
    }
  };

  function abrirChat() {
    janela.hidden = false;
    botao.setAttribute('aria-expanded', 'true');
    fechar.focus();
  }

  function fecharChat() {
    janela.hidden = true;
    botao.setAttribute('aria-expanded', 'false');
    botao.focus();
  }

  botao.addEventListener('click', function () {
    if (janela.hidden) {
      abrirChat();
    } else {
      fecharChat();
    }
  });

  fechar.addEventListener('click', fecharChat);

  document.addEventListener('keydown', function (evento) {
    if (evento.key === 'Escape' && !janela.hidden) {
      fecharChat();
    }
  });

  document.querySelectorAll('[data-cp-topic]').forEach(function (opcao) {
    opcao.addEventListener('click', function () {
      const assunto = opcao.dataset.cpTopic;
      const dados = respostas[assunto];

      if (!dados) return;

      resposta.replaceChildren();

      const mensagem = document.createElement('p');
      mensagem.className = 'cp-chat-message';
      mensagem.textContent = dados.texto;

      const link = document.createElement('a');
      link.href = dados.link;
      link.textContent = dados.botao;
      link.className = 'cp-chat-action';

      if (dados.link.startsWith('https://')) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      } else {
        link.addEventListener('click', fecharChat);
      }

      resposta.append(mensagem, link);
    });
  });
})();
