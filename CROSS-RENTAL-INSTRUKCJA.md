# Rozbudowa magazynu AV — cross-rental (21.10.2026)

## Zakres
- Plik katalogu: `data/cross-rental-catalog-2026.json` (529 unikalnych pozycji po deduplikacji i oczyszczeniu).
- Źródło nazw: przesłany 25-stronicowy przykładowy raport stanów magazynowych. Do katalogu trafiają tylko nazwy typów sprzętu, bez cudzych stanów i numerów seryjnych.
- `crossRentalPrice` = **szacunkowy** koszt pozyskania od wypożyczalni B2B, w PLN netto / doba; `price` = sugerowana cena dla klienta netto / doba.
- Stawki cross-rental nie stanowią potwierdzonych ofert dostawców. Ceny i dostępność każdorazowo należy potwierdzić.
- `stock: 0`, `ownership: "cross-rental"` = sprzęt nie jest wykazany jako własność Mark Media.

## Podstawy szacowania (publiczne stawki detaliczne, a nie cenniki B2B)
- Sennheiser EW-D, komplet: https://audio4rent.pl/wynajem/mikroport-bodypack-naglowny-sennheiser-ew-d/ (150 zł netto/doba).
- Blackmagic BiDirectional SDI/HDMI 12G: https://cyfrowarepublika.pl/?p=12041 (60 zł netto/doba).
- Podest sceniczny 2×1 m: https://projektory123.pl/wynajem/podesty-sceniczne-kratownice/wynajem-podestow-scenicznych/ (99 zł netto/doba).
- Przykłady SDI, HDMI, DeckLink: https://spooky.rent/kategoria/streaming/

## Zachowanie danych — ważne
Po pierwszym uruchomieniu kod dodaje jedynie **brakujące** pozycje do bazy na dysku trwałym `STORAGE_DIR` (Render: `/var/data`). Istniejących produktów nie aktualizuje; omija duplikaty po znormalizowanej nazwie oraz ID. Nie usuwa grup, nie zmienia stanów ani cen bieżącego magazynu. Nie dotyka szkiców i archiwum ofert.

Przed pierwszą aktualizacją bazy tworzona jest kopia:
`/var/data/equipment-db.backup-pre-crossrental-v1.json`.
Znacznik `/var/data/.cross-rental-catalog-v1.done` sprawia, że import nie powtarza się przy restarcie i nie przywraca celowo usuniętych pozycji.

## Interfejs
- Generator `/app`: osobno stawka dla klienta i szacunkowy koszt cross-rental; dynamiczne sekcje.
- Panel `/admin-magazyn.html`: podgląd i edycja obydwu cen.
- Eksport Excel zawiera `crossRentalPrice`, `ownership` i `priceStatus`; import starych arkuszy nie usuwa wartości cross-rental dla istniejących produktów.
- Nie wykonano migracji bazy danych z poprzedniej wersji poza powyższym jednorazowym dodaniem w momencie uruchomienia nowego serwera.

## Kontrola po wdrożeniu
1. Sprawdź status wdrożenia Render.
2. Zaloguj się jako administrator i przejdź do magazynu; wyszukaj `Riedel`, `FRAME LED`, `KABEL DMX`.
3. Upewnij się, że wcześniej zapisane oferty i własne stany magazynowe nadal są obecne.
4. Sprawdź czy nowy kabel XLR ma ilość 0 i oznaczenie cross-rental.
