-- Configure the two owner-supplied QR destinations without changing method IDs.
-- The bank_transfer enum remains for historical foreign-key compatibility,
-- while its customer-facing name is now the approved MariBank destination.
update public.payment_methods
set display_name = 'GCash',
    destination_label = 'Verified QR recipient',
    destination_details = 'AN***A V. - GCash mobile ending 403',
    instructions = 'Scan the QR code with GCash. Before sending, confirm the recipient is AN***A V., enter the exact order amount, and save the successful receipt and reference number.',
    qr_object_path = 'payment-qr/gcash.jpg',
    enabled = true,
    updated_at = now()
where type = 'gcash';

update public.payment_methods
set display_name = 'MariBank',
    destination_label = 'Verified QR recipient',
    destination_details = 'Angela V. - MariBank via InstaPay',
    instructions = 'Scan the QR code with MariBank or another InstaPay-enabled bank or e-wallet. Before sending, confirm the recipient is Angela V., enter the exact order amount, and save the successful receipt and reference number. Transfer fees may apply.',
    qr_object_path = 'payment-qr/maribank.jpg',
    enabled = true,
    updated_at = now()
where type = 'bank_transfer';

update public.payment_methods
set enabled = false,
    updated_at = now()
where type = 'maya';
