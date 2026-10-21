# Mark Media — konta zespołu i pack listy

## Role i uprawnienia

| Rola | Po zalogowaniu | Oferty, archiwum i ceny | Magazyn i konta | Pack listy |
| --- | --- | --- | --- | --- |
| Administrator | `/admin` | tak | tak | tak |
| Realizator | `/app` | tak | nie | tak |
| Pracownik | `/packlists` | **nie** | **nie** | **tak**, dodawanie i odznaczanie |

Admin dodaje konta w `/admin` > **Konta zespołu Mark Media**.
Starsze konta o roli `user` są traktowane jak `realizator` (bez migracji kont i archiwum).
Role są egzekwowane na serwerze, nie tylko przez ukrycie linków.

## Pack listy

Realizator zapisuje ofertę i generuje pack listę. Pracownik widzi listę realizacji pod `/packlists` i otwiera wybrane wydarzenie.
Pracownik może zaznaczyć pozycje, dodać notatkę i ręczne wyposażenie/zadanie; zmiany zapisują się w osobnych plikach `STORAGE_DIR/packlists`, nie zmieniają ofert, cen ani magazynu.
Interfejs odświeża stan z serwera co około 30 s (z wyłączeniem edycji). Przy zaznaczeniu serwer rejestruje login osoby.

Pracownik pobiera uproszczoną ofertę z `/api/packlists/:offerNumber/brief`:
bez stawek, rabatów, kosztów, e-maili klientów i danych finansowych. API ofert i magazynu zwraca mu HTTP 403.

## Automatyczne wyliczenie LED

- Yes Tech P3.9: kabinet 0,5 × 0,5 m.
- Gloshine P4/P4.8: kabinet 0,5 × 0,5 m.
- Dicolor P4: kabinet 0,5 × 1,0 m, z opcją obrotu do 1,0 × 0,5 m.
- Liczba kabinetów: osobno zaokrąglamy liczbę kolumn i rzędów w górę, a następnie mnożymy.
- Skrzynie: `ceil((kabinety + zapas) / pojemność skrzyni)`.
- Liczba ciągów DATA: `ceil(kabinety / maks. kabinetów na ciąg)`.
- Przewody DATA między kabinetami: `kabinety - ciągi DATA`.
- Przewody DATA do pierwszych kabinetów: `ciągi DATA`.
- Analogicznie dla zasilania: `ceil(kabinety / kabinetów na obwód)`, `kabinety - obwody`, `obwody`.

**Domyślne wartości są założeniami edytowalnymi, nie danymi katalogowymi:** 8 kabinetów na skrzynię, 10 na ciąg DATA, 8 na obwód AC, 0 zapasowych. Przed rzeczywistym podłączeniem należy sprawdzić instrukcję producenta, przekroje przewodów, pobór mocy i maksymalne długości ciągów. System liczy orientacyjną *liczbę*, a nie długości przewodów.

Po zapisaniu ustawień powstają osobne pozycje checklisty dla skrzyń, połączeń DATA, przewodów DATA wejściowych, połączeń zasilających, przewodów startowych oraz opcjonalnych kabinetów zapasowych. Są one automatycznie przeliczane dla każdego ekranu. Zmiana parametrów odznacza tylko automatyczne pozycje tego ekranu.

## Zasady ochrony danych i uruchomienia

- Dane personelu i uwagi organizacyjne pozostają w pliku szkicu na serwerze; kopia na GitHub pomija te pola.
- Hasła w `STORAGE_DIR/users.json` są odtąd przechowywane jako skróty scrypt. Starsze wpisy są migrowane podczas pierwszego odczytu bez usuwania kont.
- **Ważne:** wcześniejsze pliki z hasłami i historia publicznego repozytorium mogły zawierać jawne hasła. Administrator powinien niezwłocznie zmienić dotychczasowe hasła (szczególnie administratora), skonfigurować prywatne przechowywanie danych i usunąć historyczne wycieki z repozytorium osobno.
- Zmiany w repozytorium nie oznaczają automatycznie zweryfikowanego wdrożenia. Należy sprawdzić deploy, role na testowych kontach i backup dysku przed produkcyjnym użyciem.
