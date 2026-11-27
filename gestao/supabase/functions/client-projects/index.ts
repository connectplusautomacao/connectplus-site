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

async function prepareDocumentUpload(admin: ReturnType<typeof portal>, input: any) {
  const code = String(input.code || '').trim();
  const title = String(input.title || '').trim().slice(0, 120);
  const fileName = cleanDocumentName(input.fileName);
  const contentType = String(input.contentType || '').toLowerCase();
  const size = Number(input.size);
  const extensions = ALLOWED_DOCUMENT_TYPES[contentType];
  const extension = fileName.includes('.') ? `.${fileName.split('.').pop()!.toLowerCase()}` : '';
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

async function completeDocumentUpload(admin: ReturnType<typeof portal>, input: any) {
  const code = String(input.code || '').trim();
  const title = String(input.title || '').trim().slice(0, 120);
  const fileName = cleanDocumentName(input.fileName);
  const path = String(input.path || '');
  if (!code || !title || !path) throw new Error('Dados do documento incompletos.');
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

async function supportRequests(admin: ReturnType<typeof portal>, input: any) {
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

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let action = 'unknown';
  try {
    const staff = await authenticateStaff(request);
    const input = await request.json();
    action = String(input?.action || 'unknown');
    const isSupportAction = ['support_list', 'support_update'].includes(action);
    if (!isSupportAction && !['owner', 'admin'].includes(staff.role)) throw new Error('Forbidden');
    const admin = portal();
    if (input.action === 'provision') return json(await provisionProject(admin, input));
    if (input.action === 'publish_progress') return json(await publishProgress(admin, input));
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
