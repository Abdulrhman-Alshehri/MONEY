# Usage: extract.ps1 -Pdf a.pdf,b.pdf -OutDir C:\somewhere\outside\this\repo
# Pass PDFs oldest first. Output holds private data, so OutDir must be outside the repo.
param([Parameter(Mandatory)][string[]]$Pdf, [Parameter(Mandatory)][string]$OutDir)
New-Item -ItemType Directory -Force $OutDir | Out-Null
$s = $PSScriptRoot
$cs = [IO.File]::ReadAllText("$s\Stmt.cs", [Text.Encoding]::UTF8)
Add-Type -TypeDefinition $cs -ReferencedAssemblies System.Core, System.Linq, System.IO.Compression -Language CSharp

function Check($file, $tag) {
    $items = [Stmt]::Items($file)
    $rows = [Stmt]::Rows($items)
    [IO.File]::WriteAllText("$OutDir\rows_$tag.tsv", [Stmt]::Tsv($rows), (New-Object Text.UTF8Encoding $false))
    [IO.File]::WriteAllText("$OutDir\page1_$tag.txt", [Stmt]::PageOne($items), (New-Object Text.UTF8Encoding $false))
    "[$tag] items=$($items.Count) rows=$($rows.Count) unmapped=$([Stmt]::Unmapped)"

    $toNum = { param($v) if ([string]::IsNullOrWhiteSpace($v)) { 0 } else { [decimal]::Parse(($v -replace ',', ''), [Globalization.CultureInfo]::InvariantCulture) } }
    $deb = 0; $cred = 0; $debN = 0; $credN = 0; $bad = 0; $prev = $null; $i = 0
    foreach ($r in $rows) {
        $d = & $toNum $r.Debit; $c = & $toNum $r.Credit; $b = & $toNum $r.Balance
        $deb += $d; $cred += $c
        if ($d -ne 0) { $debN++ }
        if ($c -ne 0) { $credN++ }
        if ($prev -ne $null -and ($prev - $d + $c) -ne $b) { $bad++; "   balance break at row $i page $($r.Page) $($r.Date) $($r.Time): prev=$prev d=$d c=$c bal=$b" }
        $prev = $b; $i++
    }
    "   debit total=$deb count=$debN | credit total=$cred count=$credN | end balance=$prev | first=$($rows[0].Date) last=$($rows[$rows.Count-1].Date) | breaks=$bad"
}
$n = 0; foreach ($f in $Pdf) { Check $f ([string][char](97 + $n)); $n++ }
