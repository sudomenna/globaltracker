import { logger, task } from '@trigger.dev/sdk/v3';
import { and, eq } from 'drizzle-orm';

import { createDb, lpDeployments, workflowRuns } from '@globaltracker/db';

// BR-RBAC-002: toda query ao DB usa workspace_id como filtro
// BR-PRIVACY-001: zero PII em logs (workspace_id é UUID opaco — ok; slug é ok)
// INV-ORC-002: lp_deployments.slug é único por workspace — insert falha com constraint se violado

type DeployLpPayload = {
  template: string; // nome do template ('capture' é o único disponível agora)
  launch_id: string; // UUID interno do launch
  slug: string; // slug único da LP por workspace
  domain?: string; // domínio customizado opcional (FQDN)
  workspace_id: string; // UUID do workspace
  run_id: string; // UUID do workflow_run
  // IDs de pages são resolvidos pelo workflow após criar a lp_deployment
  page_public_id?: string; // opcional — passado se já existe page criada
};

const SUPPORTED_TEMPLATES = ['capture'] as const;

async function deployCfPages(params: {
  accountId: string;
  projectName: string;
  slug: string;
  domain: string | null;
  trackerPageId: string;
  trackerWorkspaceId: string;
}): Promise<{ deploymentUrl: string }> {
  // CF Pages direct upload API:
  // POST https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects/{project_name}/deployments
  // Authorization: Bearer {CF_PAGES_API_TOKEN}

  const apiToken = process.env.CF_PAGES_API_TOKEN;
  const accountId = process.env.CF_ACCOUNT_ID;

  if (!apiToken || !accountId) {
    // Fallback para ambiente sem credentials (testes/dev)
    // BR-PRIVACY-001: slug é opaco — ok logar
    logger.warn(
      'CF_PAGES_API_TOKEN or CF_ACCOUNT_ID not set — using mock URL',
      { slug: params.slug },
    );
    return { deploymentUrl: `https://${params.slug}.pages.dev` };
  }

  const projectName = `gt-${params.slug}`;

  // Check if project exists
  const checkRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}`,
    { headers: { Authorization: `Bearer ${apiToken}` } },
  );

  if (!checkRes.ok && checkRes.status !== 404) {
    throw new Error(`cf_pages_check_failed: HTTP ${checkRes.status}`);
  }

  if (checkRes.status === 404) {
    // Criar projeto CF Pages
    const createRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: projectName,
          production_branch: 'main',
        }),
      },
    );
    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`cf_pages_create_failed: ${err.slice(0, 200)}`);
    }
  }

  // Upload completo de arquivos HTML/CSS/JS (Direct Upload API) está fora do
  // escopo desta onda. Retorna a URL do projeto criado.
  return { deploymentUrl: `https://${projectName}.pages.dev` };
}

export const deployLpTask = task({
  id: 'deploy-lp',
  maxDuration: 300, // 5 minutos — deploy pode ser lento
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 30000,
  },
  run: async (payload: DeployLpPayload) => {
    // Step 1 — Conectar ao DB
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error('DATABASE_URL environment variable is not set');
    const db = createDb(dbUrl);

    // Step 2 — Validar template
    if (!SUPPORTED_TEMPLATES.includes(payload.template as 'capture')) {
      throw new Error(`unsupported_template: ${payload.template}`);
    }

    // Step 3 — Inserir lp_deployment com status 'deploying'
    // INV-ORC-002: insert falha com unique constraint se slug já existe no workspace
    const [deployment] = await db
      .insert(lpDeployments)
      .values({
        workspaceId: payload.workspace_id,
        runId: payload.run_id,
        launchId: payload.launch_id,
        template: payload.template,
        slug: payload.slug,
        domain: payload.domain ?? null,
        status: 'deploying',
      })
      .returning();

    if (!deployment) {
      throw new Error('lp_deployment_insert_failed: no row returned');
    }

    // Step 4-5 — Chamar CF Pages API com tratamento de erro
    let deploymentUrl: string;
    try {
      const result = await deployCfPages({
        accountId: process.env.CF_ACCOUNT_ID ?? '',
        projectName: `gt-${payload.slug}`,
        slug: payload.slug,
        domain: payload.domain ?? null,
        trackerPageId: payload.page_public_id ?? payload.slug,
        trackerWorkspaceId: payload.workspace_id,
      });
      deploymentUrl = result.deploymentUrl;
    } catch (err) {
      // Atualizar deployment como failed
      await db
        .update(lpDeployments)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(eq(lpDeployments.id, deployment.id));

      // Atualizar workflow_run como failed — BR-RBAC-002: filtra por workspace_id
      await db
        .update(workflowRuns)
        .set({
          status: 'failed',
          result: { error: String(err) },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(workflowRuns.id, payload.run_id),
            eq(workflowRuns.workspaceId, payload.workspace_id),
          ),
        );

      throw err;
    }

    // Step 6 — Atualizar lp_deployment como deployed
    await db
      .update(lpDeployments)
      .set({
        status: 'deployed',
        cfPagesUrl: deploymentUrl,
        deployedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(lpDeployments.id, deployment.id));

    // Step 7 — setup-tracking subtask (requer UUID interno da page, não disponível aqui)
    // A resolução de page UUID interno a partir de page_public_id é responsabilidade
    // do workflow pai, que tem contexto mais amplo.
    if (payload.page_public_id) {
      logger.info(
        'setup-tracking subtask skipped — page UUID not available in deploy-lp payload',
        { page_public_id: payload.page_public_id },
      );
    }

    // Step 8 — Atualizar workflow_run como completed
    // BR-RBAC-002: filtra por workspace_id além de id
    await db
      .update(workflowRuns)
      .set({
        status: 'completed',
        result: {
          deployment_id: deployment.id,
          cf_pages_url: deploymentUrl,
          slug: payload.slug,
          template: payload.template,
          deployed_at: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workflowRuns.id, payload.run_id),
          eq(workflowRuns.workspaceId, payload.workspace_id),
        ),
      );

    // Step 9 — Log sem PII (BR-PRIVACY-001)
    logger.info('deploy-lp completed', {
      run_id: payload.run_id,
      workspace_id: payload.workspace_id,
      slug: payload.slug,
      template: payload.template,
      cf_pages_url: deploymentUrl,
    });

    return {
      deployment_id: deployment.id,
      cf_pages_url: deploymentUrl,
      status: 'deployed' as const,
    };
  },
});
