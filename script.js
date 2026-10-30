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
      texto: '💰 Vamos preparar sua solicitação! Primeiro, escolha o serviço de automação residencial que deseja contratar.',
      link: '#contato',
      botao: 'Preencher formulário de orçamento'
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
      
if (assunto === 'orcamento') {
  iniciarOrcamentoInterativo();
  return;
}
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
  
  /* ORÇAMENTO INTERATIVO CONNECT PLUS */

  function iniciarOrcamentoInterativo() {
    resposta.replaceChildren();

    const titulo = document.createElement('p');
    titulo.className = 'cp-chat-message';
    titulo.textContent = '💰 Qual serviço você deseja contratar?';
    resposta.appendChild(titulo);

    const servicos = [
      'Iluminação inteligente',
      'Sonorização residencial',
      'Cortinas automatizadas',
      'Fechaduras digitais',
      'Rede Wi-Fi residencial',
      'Controle por voz com Alexa',
      'Automação residencial completa'
    ];

    servicos.forEach(function (servico) {
      const botao = document.createElement('button');
      botao.type = 'button';
      botao.className = 'cp-chat-choice';
      botao.textContent = servico;

      botao.addEventListener('click', function () {
        escolherImovel(servico);
      });

      resposta.appendChild(botao);
    });
  }

  function escolherImovel(servico) {
    resposta.replaceChildren();

    const titulo = document.createElement('p');
    titulo.className = 'cp-chat-message';
    titulo.textContent = '🏠 Qual é o tipo de imóvel?';
    resposta.appendChild(titulo);

    const imoveis = [
      'Casa',
      'Apartamento',
      'Imóvel em construção ou reforma'
    ];

    imoveis.forEach(function (imovel) {
      const botao = document.createElement('button');
      botao.type = 'button';
      botao.className = 'cp-chat-choice';
      botao.textContent = imovel;

      botao.addEventListener('click', function () {
        finalizarOrcamento(servico, imovel);
      });

      resposta.appendChild(botao);
    });
  }

  function finalizarOrcamento(servico, imovel) {
    resposta.replaceChildren();

    const resumo = document.createElement('p');
    resumo.className = 'cp-chat-message';
    resumo.textContent =
      '✅ Solicitação preparada!\n' +
      'Serviço: ' + servico + '\n' +
      'Imóvel: ' + imovel;
    resumo.style.whiteSpace = 'pre-line';

    resposta.appendChild(resumo);

    const texto =
      'Olá! Gostaria de solicitar um orçamento da Connect Plus.\n\n' +
      'Serviço: ' + servico + '\n' +
      'Tipo de imóvel: ' + imovel;

    const link = document.createElement('a');
    link.className = 'cp-chat-action';
    link.href =
      'https://wa.me/5571993342920?text=' +
      encodeURIComponent(texto);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '📲 Enviar solicitação pelo WhatsApp';

    resposta.appendChild(link);
  }

})();
