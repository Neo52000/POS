// Envois transactionnels Brevo (e-mail + SMS) pour le ticket dématérialisé.
// Secrets : BREVO_API_KEY (obligatoire) ; RECEIPT_SENDER_EMAIL / RECEIPT_SENDER_NAME
// (défaut contact@ma-papeterie.fr / Ma Papeterie) ; RECEIPT_SMS_SENDER (≤ 11 caractères
// alphanumériques, défaut MaPapeterie).
import { ApiError } from './http.ts';

const API = 'https://api.brevo.com/v3';

function apiKey(): string {
  const key = Deno.env.get('BREVO_API_KEY');
  if (!key) {
    throw new ApiError('DELIVERY_FAILED', 'Envoi indisponible : BREVO_API_KEY non configurée');
  }
  return key;
}

async function post(path: string, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: {
        'api-key': apiKey(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new ApiError(
      'DELIVERY_FAILED',
      `Brevo injoignable : ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
    throw new ApiError('DELIVERY_FAILED', `Brevo : ${msg}`);
  }
  return data;
}

export async function sendEmail(input: {
  to: string;
  subject: string;
  html: string;
  text: string;
  tags?: string[];
}): Promise<void> {
  await post('/smtp/email', {
    sender: {
      email: Deno.env.get('RECEIPT_SENDER_EMAIL') ?? 'contact@ma-papeterie.fr',
      name: Deno.env.get('RECEIPT_SENDER_NAME') ?? 'Ma Papeterie',
    },
    to: [{ email: input.to }],
    subject: input.subject,
    htmlContent: input.html,
    textContent: input.text,
    ...(input.tags ? { tags: input.tags } : {}),
  });
}

export async function sendSms(input: { to: string; content: string; tag?: string }): Promise<void> {
  await post('/transactionalSMS/sms', {
    sender: Deno.env.get('RECEIPT_SMS_SENDER') ?? 'MaPapeterie',
    recipient: input.to,
    content: input.content,
    type: 'transactional',
    ...(input.tag ? { tag: input.tag } : {}),
  });
}

/**
 * Numéro mobile → format international sans « + » attendu par Brevo (`33612345678`).
 * Accepte `06 12 34 56 78`, `+33 6…`, `0033 6…`. Renvoie null si invalide.
 */
export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (/^0[1-9]\d{8}$/.test(d)) d = `33${d.slice(1)}`;
  return /^[1-9]\d{7,14}$/.test(d) ? d : null;
}
