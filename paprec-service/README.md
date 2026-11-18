# MarkNet Serwis — portal zgłoszeń

Wydzielony system obsługi zgłoszeń technicznych i dokumentowania interwencji.

## Zakres
- Konta klienta i administratora, login/hasło, przechowywanie haszy scrypt, sesje z ciasteczkiem HttpOnly + Secure + SameSite.
- Zgłoszenia: usterka lub awaria, priorytet standardowy/krytyczny, kategorie CCTV/SKD/SSWiN/telefonia/LAN/światłowód/GPEC.
- Historia zdarzeń, komentarze, zmiany statusów, daty weryfikacji, przyjazdu i zakończenia.
- Załączniki PDF/JPG/PNG, maksymalnie 5 MB i 10 sztuk na zgłoszenie.
- Raport indywidualny PDF, raport miesięczny PDF, eksport CSV.
- Interfejs responsywny, język polski, strefa Europe/Warsaw.

## Wdrożenie

Projekt umieszczono w osobnej gałęzi GitHub. Działa jako odrębna usługa webowa i baza Postgres; nie zmienia generatora ofert ani strony MarkNet.

W Render należy skonfigurować zmienne środowiskowe:
- DATABASE_URL — Internal Database URL pobrany bezpośrednio z panelu bazy PostgreSQL, nigdy nie dodawać go do repozytorium.
- NODE_ENV — production.
- INIT_ADMIN_PASSWORD i INIT_CLIENT_PASSWORD — długie unikalne hasła.
- CLIENT_NAME — nazwa klienta.

Build command: cd paprec-service && npm install --omit=dev --no-audit --no-fund && npm run check
Start command: cd paprec-service && npm start

Po wdrożeniu endpoint /api/health musi zwrócić status ok. Pierwsze loginy: marknet (administrator), paprec (klient). Hasła trzeba zmienić po pierwszym zalogowaniu.

Przy braku DATABASE_URL lub haseł aplikacja pracuje w trybie konfiguracyjnym bez dostępu do API (HTTP 503).

## Bezpieczeństwo i eksploatacja

Wersja testowa na darmowym Postgres Render NIE nadaje się do obsługi produkcyjnej. Konieczna jest trwała baza, backupy, polityka retencji danych, testy odtwarzania, przegląd RODO i kontrola uprawnień. Dostęp do raportów posiada tylko administrator.

Aplikacja nie ocenia automatycznie naruszeń SLA z powodu niejednoznaczności między zapisami umowy i oferty w zakresie czasów reakcji. Rejestruje rzeczywiste daty i godziny czynności. Raporty nie potwierdzają prac, których nie odnotowano w systemie.

## Podstawowe API
POST /api/login
GET /api/me
POST /api/change-password
GET/POST /api/tickets
GET/PATCH /api/tickets/:id
POST /api/tickets/:id/events
POST /api/tickets/:id/attachments
GET /api/attachments/:id
GET /api/reports/tickets/:id.pdf
GET /api/reports/month.pdf?month=YYYY-MM
GET /api/reports/month.csv?month=YYYY-MM
