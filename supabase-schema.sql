-- Выполните это один раз в Supabase: раздел SQL Editor → New query → вставить → Run.
-- Перед этим обязательно прочитайте README.md — там описан полный порядок
-- настройки (создание двух учителей, отключение публичной регистрации и т.д.).

-- Если раньше уже была старая таблица gradebook_data (код синхронизации) —
-- она больше не нужна, можно удалить (необязательно, но чище):
-- drop table if exists public.gradebook_data;

create table if not exists public.board_data (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.board_data enable row level security;

-- На случай повторного запуска скрипта — сначала удаляем старые политики.
drop policy if exists "authenticated read board_data" on public.board_data;
drop policy if exists "authenticated write board_data" on public.board_data;

-- Читать и писать общие данные может ТОЛЬКО вошедший (authenticated)
-- пользователь. Анонимный ключ (anon) сам по себе доступа к данным не даёт —
-- доступ появляется только после успешного входа по e-mail/паролю.
-- Так как регистрация новых пользователей на сайте отключена (см. README,
-- шаг 2), войти смогут только два аккаунта, которые вы создадите вручную.
create policy "authenticated read board_data"
  on public.board_data
  for select
  to authenticated
  using (true);

create policy "authenticated write board_data"
  on public.board_data
  for insert
  to authenticated
  with check (true);

create policy "authenticated update board_data"
  on public.board_data
  for update
  to authenticated
  using (true)
  with check (true);

-- Включаем realtime-обновления для этой таблицы, чтобы если один учитель
-- что-то поменял, у второго (если сайт открыт в этот момент) экран обновился
-- сам, без перезагрузки страницы. Обёрнуто в DO-блок, чтобы скрипт можно было
-- безопасно запускать повторно (не упадёт с ошибкой «уже добавлено»).
do $$
begin
  alter publication supabase_realtime add table public.board_data;
exception
  when duplicate_object then null;
end $$;
