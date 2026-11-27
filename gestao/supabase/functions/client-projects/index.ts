import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://connectplusautomacao.github.io',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

function required(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing server configuration: ${name}`);
  return value;
}

async function authenticateStaff(request: Request) {
  const authorization = request.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) throw new Error('Unauthorized');
  const internalUrl = required('INTERNAL_SUPABASE_URL').replace(/\/$/, '');
  const internalKey = required('INTERNAL_SUPABASE_PUBLISHABLE_KEY');
  const userResponse = await fetch(`${internalUrl}/auth/v1/user`, {
    headers: { apikey: internalKey, Authorization: authorization },
  });
  if (!userResponse.ok) throw new Error('Unauthorized');
  const user = await userResponse.json();
  if (!user?.id || !user?.email) throw new Error('Unauthorized');
  const memberResponse = await fetch(
    `${internalUrl}/rest/v1/company_members?user_id=eq.${encodeURIComponent(user.id)}&select=role,active`,
    { headers: { apikey: internalKey, Authorization: authorization } },
  );
  if (!memberResponse.ok) throw new Error('Staff access could not be verified');
  const members = await memberResponse.json();
  const member = members.find((m: { role: string; active: boolean }) =>
    m.active && ['owner', 'admin', 'technician'].includes(m.role),
  );
  if (!member) throw new Error('Forbidden');
  return { user, role: member.role };
}

const portal = () => createClient(required('PORTAL_SUPABASE_URL'), required('PORTAL_SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DOCUMENT_BUCKET = 'client-documents';
const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
const SIGNATURE_CONSENT = 'Confirmo que li o documento eletrônico identificado neste portal, que sou o titular autenticado desta conta ou representante autorizado e que manifesto minha concordância em assiná-lo eletronicamente. Reconheço que este registro será associado à minha conta, ao arquivo e ao horário da confirmação.';
const ALLOWED_DOCUMENT_TYPES: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'text/plain': ['.txt'],
};

function cleanDocumentName(value: unknown) {
  const raw = String(value || 'documento').split(/[\\/]/).pop() || 'documento';
  const ascii = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]/g, '');
  const safe = ascii.replace(/[^A-Za-z0-9._ -]/g, '').trim().replace(/\s+/g, '_').slice(0, 140);
  return safe || 'documento';
}

async function prepareDocumentUpload(admin: ReturnType<typeof portal>, input: any, technicalOnly = false) {
  const code = String(input.code || '').trim();
  const title = String(input.title || '').trim().slice(0, 120);
  const fileName = cleanDocumentName(input.fileName);
  const contentType = String(input.contentType || '').toLowerCase();
  const size = Number(input.size);
  const extensions = ALLOWED_DOCUMENT_TYPES[contentType];
  const extension = fileName.includes('.') ? `.${fileName.split('.').pop()!.toLowerCase()}` : '';
  if (technicalOnly && !['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
    throw new Error('Para anexos técnicos, envie PDF, JPG, PNG ou WEBP.');
  }
  if (!code || !title || title.length < 2) throw new Error('Selecione o projeto e informe o nome do documento.');
  if (!extensions?.includes(extension)) throw new Error('Formato não permitido. Envie PDF, JPG, PNG, WEBP, DOCX, XLSX ou TXT.');
  if (!Number.isFinite(size) || size <= 0 || size > MAX_DOCUMENT_BYTES) throw new Error('O arquivo deve ter até 15 MB.');
  const { data: project, error } = await admin.from('projects').select('id').eq('code', code).maybeSingle();
  if (error) throw error;
  if (!project) throw new Error('Projeto não encontrado no portal. Libere primeiro a proposta aprovada.');
  const path = `${project.id}/${crypto.randomUUID()}-${fileName}`;
  const { data, error: signedError } = await admin.storage.from(DOCUMENT_BUCKET).createSignedUploadUrl(path);
  if (signedError) throw signedError;
  if (!data?.token) throw new Error('Não foi possível preparar o envio seguro do arquivo.');
  return { path, token: data.token, projectId: project.id };
}

async function completeDocumentUpload(admin: ReturnType<typeof portal>, input: any, technicalOnly = false) {
  const code = String(input.code || '').trim();
  const title = String(input.title || '').trim().slice(0, 120);
  const fileName = cleanDocumentName(input.fileName);
  const path = String(input.path || '');
  if (!code || !title || !path) throw new Error('Dados do documento incompletos.');
  if (technicalOnly && !/\.(pdf|jpe?g|png|webp)$/i.test(fileName)) throw new Error('O anexo técnico precisa ser PDF, JPG, PNG ou WEBP.');
  const { data: project, error: projectError } = await admin.from('projects').select('id').eq('code', code).maybeSingle();
  if (projectError) throw projectError;
  if (!project || !path.startsWith(`${project.id}/`)) throw new Error('O documento não corresponde ao projeto selecionado.');
  const { data: existing, error: existingError } = await admin.from('project_documents')
    .select('id').eq('storage_path', path).maybeSingle();
  if (existingError) throw existingError;
  if (existing) return { ok: true, documentId: existing.id };
  const { data: file, error: fileError } = await admin.storage.from(DOCUMENT_BUCKET).download(path);
  if (fileError || !file) throw fileError || new Error('O arquivo ainda não chegou ao armazenamento privado.');
  const { data, error } = await admin.from('project_documents').insert({
    project_id: project.id,
    title,
    file_name: fileName,
    storage_path: path,
    visible_to_client: true,
  }).select('id').single();
  if (error) {
    await admin.storage.from(DOCUMENT_BUCKET).remove([path]);
    throw error;
  }
  return { ok: true, documentId: data.id };
}

async function provisionProject(admin: ReturnType<typeof portal>, input: any) {
  const email = String(input.email || '').trim().toLowerCase();
  const code = String(input.code || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(email) || !code || code.length > 80) throw new Error('E-mail ou número da proposta inválido.');
  const proposal = input.proposal;
  if (!proposal || String(proposal.code || '') !== code) throw new Error('A proposta aprovada não foi informada corretamente.');

  const { data: existingProject, error: findError } = await admin.from('projects').select('id').eq('code', code).maybeSingle();
  if (findError) throw findError;

  if (existingProject) {
    const { data: assigned, error: assignedError } = await admin.from('project_members')
      .select('user_id').eq('project_id', existingProject.id);
    if (assignedError) throw assignedError;
    for (const member of assigned || []) {
      const { data: existingUser, error: userError } = await admin.auth.admin.getUserById(member.user_id);
      if (userError) throw userError;
      if (existingUser.user?.email?.toLowerCase() !== email) {
        throw new Error('Este número de proposta já está associado a outra conta. Confira o número antes de continuar.');
      }
    }
  }

  let user = null;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    user = data.users.find((candidate) => candidate.email?.toLowerCase() === email) || null;
    if (user || data.users.length < 1000) break;
  }
  let inviteSent = false;
  if (!user) {
    const portalUrl = required('PORTAL_SITE_URL').replace(/\/$/, '') + '/';
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: portalUrl });
    if (error) throw error;
    user = data.user;
    inviteSent = true;
  }
  if (!user?.id) throw new Error('Não foi possível localizar ou criar a conta do cliente.');

  let projectId = existingProject?.id;
  const projectValues = {
    code,
    title: String(proposal.title || `Projeto Connect Plus · ${proposal.client || email}`).slice(0, 180),
    approved_proposal: proposal,
  };
  if (projectId) {
    const { error } = await admin.from('projects').update(projectValues).eq('id', projectId);
    if (error) throw error;
  } else {
    const { data, error } = await admin.from('projects').insert(projectValues).select('id').single();
    if (error) throw error;
    projectId = data.id;
  }
  const { error: memberError } = await admin.from('project_members').upsert(
    { project_id: projectId, user_id: user.id }, { onConflict: 'project_id,user_id', ignoreDuplicates: true },
  );
  if (memberError) throw memberError;
  return { projectId, email, inviteSent };
}

async function publishProgress(admin: ReturnType<typeof portal>, input: any) {
  const code = String(input.code || '').trim();
  const progress = Math.max(0, Math.min(100, Number(input.progress) || 0));
  const allowed = ['Em planejamento', 'Visita técnica', 'Preparação', 'Instalação', 'Testes', 'Concluído', 'Concluído com pendências'];
  const status = allowed.includes(input.status) ? input.status : 'Em planejamento';
  const { data: project, error: findError } = await admin.from('projects').select('id').eq('code', code).maybeSingle();
  if (findError || !project) throw findError || new Error('Projeto não liberado no portal.');
  const values: Record<string, unknown> = {
    status,
    progress,
    next_step: String(input.nextStep || 'A equipe atualizará em breve').slice(0, 240),
    expected_date: input.expectedDate || null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await admin.from('projects').update(values).eq('id', project.id);
  if (error) throw error;
  const message = String(input.message || '').trim();
  if (message) {
    const { error: updateError } = await admin.from('project_updates').insert({
      project_id: project.id,
      title: String(input.updateTitle || 'Andamento do serviço').slice(0, 120),
      message: message.slice(0, 1600),
      visible_to_client: true,
    });
    if (updateError) throw updateError;
  }
  return { ok: true };
}

async function publishExecutionUpdate(admin: ReturnType<typeof portal>, input: any) {
  const code = String(input.code || '').trim();
  const stage = String(input.stage || '').trim().slice(0, 80);
  const date = String(input.date || '').trim().slice(0, 10);
  const message = String(input.message || '').trim().slice(0, 1200);
  if (!code || !message) throw new Error('Selecione um projeto e escreva o resumo que será publicado.');
  const allowedStages = ['Visita técnica', 'Elaboração do projeto', 'Documentação', 'Solicitação de materiais', 'Instalação', 'Configuração', 'Testes', 'Treinamento e entrega', 'Retorno técnico'];
  if (!allowedStages.includes(stage)) throw new Error('Selecione uma etapa técnica válida.');
  const { data: project, error: findError } = await admin.from('projects').select('id, progress').eq('code', code).maybeSingle();
  if (findError || !project) throw findError || new Error('Projeto não liberado no portal.');
  const stages: Record<string, { progress: number; status: string; nextStep: string }> = {
    'Visita técnica': { progress: 10, status: 'Visita técnica', nextStep: 'Levantamento técnico realizado; a equipe seguirá com o projeto.' },
    'Elaboração do projeto': { progress: 25, status: 'Preparação', nextStep: 'A equipe está elaborando o projeto técnico.' },
    'Documentação': { progress: 40, status: 'Preparação', nextStep: 'A documentação do projeto está sendo organizada.' },
    'Solicitação de materiais': { progress: 55, status: 'Preparação', nextStep: 'Os materiais necessários foram identificados e solicitados.' },
    'Instalação': { progress: 75, status: 'Instalação', nextStep: 'A equipe está realizando a instalação dos equipamentos.' },
    'Configuração': { progress: 85, status: 'Instalação', nextStep: 'A equipe está configurando os equipamentos e integrações.' },
    'Testes': { progress: 95, status: 'Testes', nextStep: 'O sistema está em fase de testes e ajustes finais.' },
    'Treinamento e entrega': { progress: 100, status: 'Concluído', nextStep: 'Instalação concluída; o cliente recebeu a demonstração e o treinamento.' },
  };
  const milestone = stages[stage];
  const currentProgress = Math.max(0, Math.min(100, Number(project.progress) || 0));
  if (milestone && milestone.progress >= currentProgress) {
    const { error: progressError } = await admin.from('projects').update({
      status: milestone.status,
      progress: milestone.progress,
      next_step: milestone.nextStep,
      updated_at: new Date().toISOString(),
    }).eq('id', project.id);
    if (progressError) throw progressError;
  }
  const title = `Diário da obra · ${stage || 'Atualização técnica'}`.slice(0, 120);
  const body = date ? `${date}\n\n${message}` : message;
  const { error } = await admin.from('project_updates').insert({
    project_id: project.id,
    title,
    message: body,
    visible_to_client: true,
  });
  if (error) throw error;
  return { ok: true };
}

async function supportRequests(admin: ReturnType<typeof portal>, input: any) {
  if (input.action === 'client_support_list') {
    const user = input.clientUser;
    const projectId = String(input.projectId || '');
    if (!user?.id || !projectId) throw new Error('Projeto inválido para consultar os atendimentos.');
    const { data: membership, error: membershipError } = await admin.from('project_members')
      .select('project_id').eq('project_id', projectId).eq('user_id', user.id).maybeSingle();
    if (membershipError) throw membershipError;
    if (!membership) throw new Error('Este projeto não está liberado para esta conta.');
    const { data, error } = await admin.from('support_requests')
      .select('id, subject, status, created_at, updated_at')
      .eq('project_id', projectId).eq('user_id', user.id)
      .order('created_at', { ascending: false }).limit(20);
    if (error) throw error;
    return { requests: data || [] };
  }
  if (input.action === 'support_list') {
    const { data, error } = await admin.from('support_requests')
      .select('id, project_id, user_id, subject, message, contact_phone, status, staff_note, created_at, projects(code,title)')
      .order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    const requests = await Promise.all((data || []).map(async (row) => {
      const { data: result, error: userError } = await admin.auth.admin.getUserById(row.user_id);
      if (userError) throw userError;
      return { ...row, client_email: result.user?.email || '' };
    }));
    return { requests };
  }
  const id = String(input.id || '');
  const status = ['Recebido', 'Em análise', 'Em atendimento', 'Concluído'].includes(input.status) ? input.status : null;
  if (!id || !status) throw new Error('Atualização de suporte inválida.');
  const { error } = await admin.from('support_requests').update({
    status,
    staff_note: String(input.staffNote || '').slice(0, 1000),
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) throw error;
  return { ok: true };
}

async function authenticatePortalClient(request: Request, admin: ReturnType<typeof portal>) {
  const authorization = request.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) throw new Error('Unauthorized');
  const token = authorization.slice('Bearer '.length);
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user?.id || !data.user.email) throw new Error('Unauthorized');
  return data.user;
}

async function signClientDocument(admin: ReturnType<typeof portal>, input: any, request: Request, user: any) {
  const documentId = String(input.documentId || '').trim();
  const signerName = String(input.signerName || '').trim().replace(/\s+/g, ' ').slice(0, 180);
  if (!documentId || signerName.length < 2 || input.accepted !== true) {
    throw new Error('Confira o documento, informe seu nome completo e confirme a declaração para assinar.');
  }

  const { data: document, error: documentError } = await admin.from('project_documents')
    .select('id, project_id, title, file_name, storage_path, visible_to_client')
    .eq('id', documentId).eq('visible_to_client', true).maybeSingle();
  if (documentError) throw documentError;
  if (!document) throw new Error('Este documento não está disponível para assinatura.');
  const { data: membership, error: membershipError } = await admin.from('project_members')
    .select('project_id').eq('project_id', document.project_id).eq('user_id', user.id).maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership) throw new Error('Sua conta não tem acesso a este projeto.');

  const { data: prior, error: priorError } = await admin.from('client_document_signatures')
    .select('id, signed_at, signer_name, document_sha256')
    .eq('document_id', document.id).eq('user_id', user.id).maybeSingle();
  if (priorError) throw priorError;
  if (prior) return { ok: true, alreadySigned: true, signature: prior };

  const { data: file, error: fileError } = await admin.storage.from(DOCUMENT_BUCKET).download(document.storage_path);
  if (fileError || !file) throw fileError || new Error('Não foi possível conferir o arquivo antes da assinatura.');
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const documentSha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const { data: signature, error: signatureError } = await admin.from('client_document_signatures').insert({
    document_id: document.id,
    project_id: document.project_id,
    user_id: user.id,
    signer_name: signerName,
    signer_email: user.email.toLowerCase(),
    document_title: String(document.title || 'Documento Connect Plus').slice(0, 180),
    document_file_name: String(document.file_name || 'documento').slice(0, 180),
    document_sha256: documentSha256,
    consent_text: SIGNATURE_CONSENT,
    user_agent: String(request.headers.get('User-Agent') || '').slice(0, 500),
  }).select('id, signed_at, signer_name, document_sha256').single();
  if (signatureError?.code === '23505') {
    const { data: duplicate, error: duplicateError } = await admin.from('client_document_signatures')
      .select('id, signed_at, signer_name, document_sha256')
      .eq('document_id', document.id).eq('user_id', user.id).maybeSingle();
    if (duplicateError) throw duplicateError;
    if (duplicate) return { ok: true, alreadySigned: true, signature: duplicate };
  }
  if (signatureError) throw signatureError;
  return { ok: true, alreadySigned: false, signature };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let action = 'unknown';
  try {
    const input = await request.json();
    action = String(input?.action || 'unknown');
    const admin = portal();
    if (action === 'client_sign_document') {
      const user = await authenticatePortalClient(request, admin);
      return json(await signClientDocument(admin, input, request, user));
    }
    if (action === 'client_support_list') {
      const user = await authenticatePortalClient(request, admin);
      return json(await supportRequests(admin, { ...input, clientUser: user }));
    }
    const staff = await authenticateStaff(request);
    const isSupportAction = ['support_list', 'support_update'].includes(action);
    const isExecutionUpdate = action === 'publish_execution_update';
    const isTechnicalDocumentAction = ['prepare_technical_document_upload', 'complete_technical_document_upload'].includes(action);
    if (!isSupportAction && !isExecutionUpdate && !isTechnicalDocumentAction && !['owner', 'admin'].includes(staff.role)) throw new Error('Forbidden');
    if (input.action === 'provision') return json(await provisionProject(admin, input));
    if (input.action === 'publish_progress') return json(await publishProgress(admin, input));
    if (input.action === 'publish_execution_update') return json(await publishExecutionUpdate(admin, input));
    if (input.action === 'prepare_technical_document_upload') return json(await prepareDocumentUpload(admin, input, true));
    if (input.action === 'complete_technical_document_upload') return json(await completeDocumentUpload(admin, input, true));
    if (input.action === 'prepare_document_upload') return json(await prepareDocumentUpload(admin, input));
    if (input.action === 'complete_document_upload') return json(await completeDocumentUpload(admin, input));
    if (input.action === 'support_list' || input.action === 'support_update') return json(await supportRequests(admin, input));
    return json({ error: 'Unknown action' }, 400);
  } catch (error) {
    const err = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    const candidate = error instanceof Error ? error.message : err.message;
    const message = typeof candidate === 'string' && candidate.trim() ? candidate : 'Internal error';
    const code = typeof err.code === 'string' ? err.code : undefined;
    console.error('client-projects request failed', { action, message, code });
    const status = message === 'Unauthorized' ? 401 : message === 'Forbidden' ? 403 : message === 'Internal error' ? 500 : 400;
    return json({ error: message }, status);
  }
});
