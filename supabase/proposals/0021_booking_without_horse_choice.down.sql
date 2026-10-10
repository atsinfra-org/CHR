-- Rollback for 0021. Restores the previous rider confirmation text by
-- re-applying book_class() from 0017_store_credit_functions.sql (run that
-- function's "create or replace function public.book_class(...)" block), then:
drop function if exists public.session_availability(date);
-- Notification bodies trimmed by 0021 are not restored (the horse name is not kept).
