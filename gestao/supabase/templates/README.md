# Convite do Portal do Cliente

Assunto sugerido: `Seu acesso ao Portal do Cliente Connect Plus`

O modelo `invite-user.html` usa as variáveis de convite do Supabase:

- `{{ .ConfirmationURL }}`: link seguro de ativação enviado pelo Supabase.
- `{{ .Data.full_name }}`: nome do cliente.
- `{{ .Data.project_code }}`: código da proposta/projeto.
- `{{ .Data.project_title }}`: título do projeto.

O envio da função `client-projects` inclui nome, código e título no `user_metadata` somente ao criar uma nova conta. Para editar e usar esse modelo no projeto hospedado, é necessário configurar SMTP personalizado em Authentication → Emails → SMTP Settings e então copiar o assunto e o HTML para o template Invite user.
