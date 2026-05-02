# Como mapear e capturar campos de formulário (Landing Pages Externas)

**Resumo:**
Este documento é um guia baseado na arquitetura do GlobalTracker sobre como o sistema lida com a configuração de landing pages externas e a captura de dados de formulários (como Nome, Email, Telefone e UTMs). Ele explica que o script do sistema não raspa dados sensíveis (PII) automaticamente por questões de segurança e privacidade. O mapeamento pode ser feito de forma programática via API JavaScript ou de forma declarativa via configurações de eventos (`event_config`) no backend. Além disso, os dados sensíveis são criptografados no banco e têm visibilidade restrita no dashboard, dependendo das permissões do usuário (Privacy by Design).

---

## 1. Configuração da Landing Page e Instalação do Script

Para monitorar uma landing page hospedada fora do GlobalTracker:
1. Cadastre a página no painel (MOD-PAGE). O sistema irá gerar os identificadores necessários e você deverá autorizar o domínio (`allowed_domains`) via CORS.
2. Instale o script (`tracker.js`) na sua página, passando os identificadores gerados (como `data-site-token`, `data-launch-public-id`, etc.).

## 2. Captura de Dados do Formulário

O Tracker.js é extremamente leve e focado em privacidade. **Ele não copia automaticamente todos os campos do seu formulário** (para evitar o vazamento acidental de dados pessoais, o PII). Em vez disso, a captura de dados deve ser explicitamente mapeada através de uma das opções abaixo:

### Opção A: Mapeamento Programático (Recomendado)
O desenvolvedor da página externa mapeia os campos usando Javascript padrão e submete para a API do Tracker usando a função `window.Funil.identify()`:

```javascript
document.getElementById('meu-form').addEventListener('submit', function(e) {
  e.preventDefault();
  
  const leadData = {
    email: document.querySelector('input[name="email"]').value,
    phone: document.querySelector('input[name="telefone"]').value,
    name: document.getElementById('nome').value
  };

  // Envia com segurança para a rota /v1/lead do GlobalTracker
  window.Funil.identify(leadData); 
});
```

### Opção B: Mapeamento Declarativo (`event_config`)
O profissional de marketing cadastra regras declarativas no painel do GlobalTracker. Nessas configurações, é possível definir os **IDs**, **Names** ou **Seletores CSS** do formulário e dos campos que representam cada dado. Quando a página é carregada, o Tracker lê essas regras via `/v1/config` e escuta exatamente os campos especificados para capturar e enviar os dados, sem vasculhar o DOM inteiro.

## 3. Visibilidade e Persistência no Dashboard

O GlobalTracker possui uma arquitetura severa de segurança (*Privacy by Design*):

- **UTMs e Conversão:** As UTMs e interações do usuário são totalmente persistidas no sistema (`lead_attribution`). Analistas e profissionais de marketing verão o cruzamento de conversões com UTMs normalmente no dashboard.
- **Proteção de PII (Nome, Email, Telefone):** O banco de dados salva a PII, mas **criptografada**. Analistas normais verão os dados ofuscados (ex: `j***@email.com`).
- **Acesso ao Dado em Claro:** Apenas usuários com a função (Role) de **Dono** ou **Oficial de Privacidade** podem visualizar a PII completa. E atenção: a visualização do dado sem máscara cria um registro inalterável de auditoria (`audit_log`), registrando quem viu qual dado e quando.
