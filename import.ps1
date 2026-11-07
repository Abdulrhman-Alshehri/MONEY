# Env: SNB_WORK (extract.ps1 output folder), SEQ_START (highest seq in the database), and to really send: SMS_URL, APP_TOKEN, CONFIRM_IMPORT=yes
$old = $env:SNB_WORK; if (-not $old) { throw "Set SNB_WORK" }
$mccCat = @{
 '5814'='Food & Cafes';'5812'='Food & Cafes';'5411'='Groceries';'5499'='Groceries';'5441'='Groceries';'5331'='Groceries';
 '5541'='Fuel';'4121'='Transport';'4722'='Travel';'7011'='Travel';'5815'='Subscriptions';'5818'='Subscriptions';'7372'='Subscriptions';
 '4814'='Bills & Telecom';'4816'='Bills & Telecom';'6012'='Wallets & Finance';'6513'='Rent & Housing';'5912'='Health';
 '5947'='Shopping';'5661'='Shopping';'5651'='Shopping';'5942'='Shopping';'5999'='Shopping';'5199'='Shopping';'5399'='Shopping';
 '7832'='Entertainment';'7997'='Entertainment';'7941'='Entertainment';'7210'='Personal Care';'7230'='Personal Care'
}
$mccName = @{ '5814'='Food';'5812'='Restaurant';'5411'='Supermarket';'4814'='Telecom';'4816'='Internet';'6012'='Wallet/Finance';'7372'='Software';'7832'='Cinema';'6513'='Rent';'5399'='Shopping';'5331'='Shopping';'4121'='Taxi' }
$seen = @{}; $rows = New-Object System.Collections.ArrayList; $seq = [int]$env:SEQ_START
$prevDate = $null; $prevMin = -1
foreach ($f in (Get-ChildItem "$old\rows_*.tsv" | Sort-Object Name | ForEach-Object Name)) {
 foreach ($line in [IO.File]::ReadAllLines("$old\$f", [Text.Encoding]::UTF8)) {
  if (-not $line.Trim()) { continue }
  $c = $line.Split("`t")
  $date=$c[1];$time=$c[2];$type=$c[3];$cr=$c[4] -replace ',','';$db=$c[5] -replace ',','';$bal=$c[6] -replace ',','';$d=@($c[7].Split('|') | ForEach-Object { $_.Trim() })
  $ref = "stmt:$date $time $db $cr $bal"
  if ($seen[$ref]) { continue }; $seen[$ref]=1; $seq++
  $mcc = $null; foreach ($x in $d) { if ($x -match '^MCC-(\d+)') { $mcc=$Matches[1] } }
  $city = $null; $i=-1; for ($q=0;$q -lt $d.Count;$q++) { if ($d[$q] -match '^MC\d{4}$') { $i=$q; break } }; if ($i -ge 0 -and $i+1 -lt $d.Count) { $n=$d[$i+1]; if ($n -eq '1.000000' -and $i+2 -lt $d.Count) { $n=$d[$i+2] }; if ($n -notmatch '^(Charges|MCC|CITY|\d)') { $city=$n } }
  $first = $d[0]; $amt = if ($db) { $db } else { $cr }
  $idLine = -1; for ($k=0;$k -lt $d.Count;$k++) { if ($d[$k] -match 'رقم الهوية') { $idLine=$k } }
  $kind='purchase';$chan='pos';$cat=$null;$m=$null
  if ($type -match '^شراء انترنت|عملية شراء|خصم') { $chan='online' }
  if ($type -match 'دولي|الخليج') { $chan='intl' }
  if ($type -match 'إعادة|عكس') { $kind='refund' }
  elseif ($type -match 'إيداع رواتب|حساب المواطن|مكافأة طلاب|من صاحب العمل' -or ($type -match '^حوالة محلية واردة' )) { $kind='income';$chan='bank';$cat='Income'; $m= if ($type -match 'المواطن') {'Citizen Account'} else {$d[1]} }
  elseif ($type -match 'إيداع نقدي') { $kind='cash_in';$chan='atm';$cat='Cash deposit';$m='ATM cash deposit' }
  elseif ($type -match 'سحب نقدي') { $chan='atm';$cat='Cash withdrawal';$m='ATM cash withdrawal' }
  elseif ($type -match 'سداد') { $chan='bank';$m=$first }
  elseif ($type -match 'رسوم') { $kind='fee';$chan='bank';$cat='Fees';$m='Transfer fee' }
  elseif ($type -match 'ضريبة') { $kind='fee';$chan='bank';$cat='Fees';$m='VAT on fee' }
  elseif ($type -match '^حوالة صادرة') { $chan='bank';$cat='Government';$m='Traffic fine' }
  elseif ($type -match 'وارد' -and $first -match '^عكس.*نقاط بيع') { $kind='refund';$m='Card refund'; if ($first -match 'دولي') { $chan='intl' } }
  elseif ($type -match 'واردة|وارد') { $kind='transfer_in';$chan='transfer';$cat='Transfers'; $m= if ($idLine -ge 0) {$d[$idLine+1]} else {$d[2]} }
  elseif ($type -match 'صادرة|صادر') { $kind='transfer_out';$chan='transfer';$cat='Transfers'; $m= if ($idLine -ge 0) {$d[$idLine+1]} else {$first} }
  $m = if ($m) { ($m -replace '^السيد ','') } else { $null }
  if (-not $m) {
   if ($line -match 'PLAYSTATION') { $m='PlayStation';$cat='Entertainment' }
   elseif ($first -match '^(.*),INTL ATM') { $m="$($Matches[1]) (intl)" }
   elseif ($first -match '^riyadh,bolt') { $m='Bolt' }
   elseif ($first -match '^,(.+)') { $m=$Matches[1] }
   elseif ($first -match '^([^,]+),') { $m=$Matches[1].Trim() }
   elseif ($kind -eq 'refund') { $m= if ($first -match '^noon$') {'Noon'} else {$first} }
   elseif ($mcc -eq '4121' -and $city -eq 'Jebah') { $m='Jeeny' }
   elseif ($mcc -eq '4121' -and $line -match 'MCF') { $m='Bolt' }
   elseif ($city -eq 'MYSR q Public') { $m=$city }
   elseif ($chan -eq 'intl') { $m="$city (intl)" }
   else { $l=$mccName[$mcc]; if (-not $l) { $l="MCC $mcc" }; $m="Online: $l" }
  }
  if (-not $cat) {
   if ($m -match 'Jeeny|Bolt') { $cat='Transport' } elseif ($m -match '^Noon$') { $cat='Groceries' }
   elseif ($mcc -and $mccCat[$mcc]) { $cat=$mccCat[$mcc] } else { $cat='Uncategorized' }
  }
  # Bank lists rows in posting order: an after-midnight purchase can carry the previous date.
  $p=$date.Split('/'); $dt=[datetime]::new([int]$p[2],[int]$p[1],[int]$p[0]); $t=$time.Split(':'); $min=[int]$t[0]*60+[int]$t[1]
  $real=$dt; if ($kind -eq 'purchase' -and $date -eq $prevDate -and $min -lt $prevMin -and [int]$t[0] -lt 6) { $real=$dt.AddDays(1) }
  $prevDate=$date;$prevMin=$min
  [void]$rows.Add(@{ amount=[decimal]$amt; merchant=$m; type=$chan; kind=$kind; category=$cat; city=$city; mcc=$mcc; balance=[decimal]$bal; source='statement'; ref=$ref; seq=$seq; occurred_at=$real.ToString('yyyy-MM-dd')+"T$($time):00+03:00" })
 }
}
"rows: $($rows.Count)"
$rows | Group-Object { $_.kind } | ForEach-Object { "$($_.Name): $($_.Count) = $(($_.Group | ForEach-Object { $_.amount } | Measure-Object -Sum).Sum)" }
"--- spend by category"
$rows | Where-Object { $_.kind -in 'purchase','fee' } | Group-Object { $_.category } | ForEach-Object { [pscustomobject]@{c=$_.Name;n=$_.Count;s=($_.Group | ForEach-Object { $_.amount } | Measure-Object -Sum).Sum} } | Sort-Object s -Descending | ForEach-Object { "$($_.c): $($_.n) = $($_.s)" }
$json = $rows | ConvertTo-Json -Depth 3 -Compress
if ($env:CONFIRM_IMPORT -ne "yes") { "Dry run: nothing sent"; return }
$r = Invoke-RestMethod -Method Post -Uri "$($env:SMS_URL)?action=import" -Headers @{"x-api-key"=$env:APP_TOKEN} -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($json))
$r | ConvertTo-Json -Compress
