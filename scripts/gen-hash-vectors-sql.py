#!/usr/bin/env python3
"""Convertit packages/core/src/__fixtures__/hash-vectors.json (format @pos/core) vers le format
attendu par scripts/sql-tests/pos/03_hash_vectors.sql et la migration pos_hash_vectors_check
({name, register_code, ticket_number, prev_hash, payload, canonical_string, hash, lines_digest, payments_digest}).
Usage : python3 scripts/gen-hash-vectors-sql.py > /tmp/vectors.json
"""
import json, sys, pathlib
root = pathlib.Path(__file__).resolve().parents[1]
v = json.load(open(root / 'packages/core/src/__fixtures__/hash-vectors.json'))
out = []
for vec in v['vectors']:
    i = vec['input']
    payload = {
        'client_txn_id': i['client_txn_id'], 'kind': i['kind'], 'business_at': i['business_at'],
        'customer_account_id': i.get('customer_account_id'),
        'lines': [{k: l[k] for k in ('line_no', 'product_id', 'ean', 'label', 'qty', 'unit_price_ttc_cents', 'vat_rate', 'discount_percent')} for l in i['lines']],
        'payments': [{'method': p['method'], 'amount_cents': p['amount_cents'], **({'reference': p['reference']} if p.get('reference') else {})} for p in i['payments']],
        'change_cents': i.get('change_cents', 0),
        'totals': {'total_ht_cents': i['total_ht_cents'], 'total_vat_cents': i['total_vat_cents'], 'total_ttc_cents': i['total_ttc_cents']},
    }
    if i['kind'] == 'refund':
        payload['refund_reason'] = 'vecteur'
    out.append({'name': vec['name'], 'register_code': i['register_code'], 'ticket_number': i['ticket_number'],
                'prev_hash': i.get('prev_hash', ''), 'payload': payload, 'canonical_string': vec['canonical_string'],
                'hash': vec['hash'], 'lines_digest': vec['lines_digest'], 'payments_digest': vec['payments_digest']})
json.dump(out, sys.stdout, ensure_ascii=False)
