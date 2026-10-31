// Pont contacts de passage (hors périmètre fiscal) : vente rattachée à une personne de passage
// ma-papeterie (passage_contacts). Outbox pos_transaction_passage_contacts (projet Pos), lue par
// pos_sales_sync_pending → pos_record_sales. Ne lève jamais : un échec n'affecte pas la vente.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export async function recordPassageContact(
  db: SupabaseClient,
  transactionId: string,
  passageContactId: string,
): Promise<string | null> {
  const { error } = await db.rpc('pos_passage_contact_record', {
    p_transaction_id: transactionId,
    p_passage_contact_id: passageContactId,
  });
  if (error) {
    console.error(`[passage-contact] pos_passage_contact_record: ${error.message}`);
    return error.message;
  }
  return null;
}
