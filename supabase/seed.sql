-- Safe test-only seed. This intentionally does not enable sales or payment methods.
-- Add verified TEST destinations in the Supabase test project before exercising checkout.
update public.courses set sales_enabled = false where slug = 'logistics-101';
