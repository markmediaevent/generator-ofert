# Update: logowanie SQLite + panel użytkowników

Co dodano:
- logowanie wymagane do generatora ofert i panelu admina,
- baza użytkowników w SQLite: `data/auth.sqlite`,
- panel użytkowników w `/admin`,
- tworzenie kont, reset haseł, blokowanie i usuwanie kont,
- role: `admin` oraz `user`,
- sesje ważne 7 dni,
- API magazynu i szkiców zabezpieczone tokenem logowania.

Domyślne pierwsze konto:
- login: `admin`
- hasło: `markmedia123`

Można zmienić przez zmienne środowiskowe Rendera przed pierwszym uruchomieniem:
- `ADMIN_USER`
- `ADMIN_PASS`

Bardzo ważne przy update:
- NIE usuwaj pliku `data/equipment-db.json`, bo to magazyn sprzętu.
- NIE usuwaj katalogu `drafts` ani `data/drafts`, jeśli masz tam szkice.
- Ten update nie zawiera magazynu sprzętu, żeby go nie nadpisać.
- Przy pierwszym uruchomieniu system sam utworzy `data/auth.sqlite`.
