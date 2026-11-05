using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

public class Item { public int Page; public double X, Y, Size; public string Font, Text; }

public class Row {
    public int Page; public string Date, Time, Type; public List<string> Desc = new List<string>();
    public string Credit = "", Debit = "", Balance = "";
    public double DateY;
}

public static class Stmt {
    class Obj { public int Num; public string Dict; public byte[] Raw; }
    static readonly Encoding L1 = Encoding.GetEncoding(28591);
    public static int Unmapped = 0;

    static Dictionary<int, Obj> Load(string path) {
        byte[] b = File.ReadAllBytes(path);
        string t = L1.GetString(b);
        var d = new Dictionary<int, Obj>();
        foreach (Match m in Regex.Matches(t, @"(?<![0-9])(\d+)\s+(\d+)\s+obj\b")) {
            int start = m.Index + m.Length;
            int end = t.IndexOf("endobj", start, StringComparison.Ordinal);
            if (end < 0) continue;
            string body = t.Substring(start, end - start);
            var o = new Obj { Num = int.Parse(m.Groups[1].Value) };
            int s = body.IndexOf("stream", StringComparison.Ordinal);
            if (s >= 0) {
                o.Dict = body.Substring(0, s).Trim();
                int ds = start + s + 6;
                if (t[ds] == '\r') ds++;
                if (t[ds] == '\n') ds++;
                int de = t.IndexOf("endstream", ds, StringComparison.Ordinal);
                o.Raw = new byte[de - ds];
                Array.Copy(b, ds, o.Raw, 0, de - ds);
            } else o.Dict = body.Trim();
            d[o.Num] = o;
        }
        return d;
    }

    static byte[] Inflate(byte[] raw) {
        using (var ms = new MemoryStream(raw, 2, raw.Length - 2))
        using (var ds = new DeflateStream(ms, CompressionMode.Decompress))
        using (var outp = new MemoryStream()) { ds.CopyTo(outp); return outp.ToArray(); }
    }

    static string HexToStr(string h) {
        var sb = new StringBuilder();
        for (int i = 0; i + 3 < h.Length; i += 4) sb.Append((char)Convert.ToInt32(h.Substring(i, 4), 16));
        return sb.ToString();
    }

    static Dictionary<int, string> ParseCMap(string s) {
        var map = new Dictionary<int, string>();
        foreach (Match sec in Regex.Matches(s, @"beginbfrange(.*?)endbfrange", RegexOptions.Singleline)) {
            foreach (Match m in Regex.Matches(sec.Groups[1].Value, @"<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>")) {
                int lo = Convert.ToInt32(m.Groups[1].Value, 16), hi = Convert.ToInt32(m.Groups[2].Value, 16);
                string dst = m.Groups[3].Value;
                if (dst.Length == 4) { int u = Convert.ToInt32(dst, 16); for (int c = lo; c <= hi; c++) map[c] = ((char)(u + c - lo)).ToString(); }
                else for (int c = lo; c <= hi; c++) map[c] = HexToStr(dst);
            }
            foreach (Match m in Regex.Matches(sec.Groups[1].Value, @"<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[(.*?)\]", RegexOptions.Singleline)) {
                int lo = Convert.ToInt32(m.Groups[1].Value, 16);
                int i = 0;
                foreach (Match v in Regex.Matches(m.Groups[3].Value, @"<([0-9a-fA-F]+)>")) map[lo + i++] = HexToStr(v.Groups[1].Value);
            }
        }
        foreach (Match sec in Regex.Matches(s, @"beginbfchar(.*?)endbfchar", RegexOptions.Singleline))
            foreach (Match m in Regex.Matches(sec.Groups[1].Value, @"<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>"))
                map[Convert.ToInt32(m.Groups[1].Value, 16)] = HexToStr(m.Groups[2].Value);
        return map;
    }

    static List<int> PageObjects(Dictionary<int, Obj> objs) {
        var res = new List<int>();
        int rootPages = -1;
        foreach (var o in objs.Values) if (Regex.IsMatch(o.Dict, @"/Type\s*/Catalog\b")) rootPages = int.Parse(Regex.Match(o.Dict, @"/Pages\s+(\d+)\s+0\s+R").Groups[1].Value);
        Action<int> walk = null;
        walk = n => {
            var o = objs[n];
            if (Regex.IsMatch(o.Dict, @"/Type\s*/Pages\b")) {
                var kids = Regex.Match(o.Dict, @"/Kids\s*\[(.*?)\]", RegexOptions.Singleline).Groups[1].Value;
                foreach (Match k in Regex.Matches(kids, @"(\d+)\s+0\s+R")) walk(int.Parse(k.Groups[1].Value));
            } else res.Add(n);
        };
        walk(rootPages);
        return res;
    }

    static bool IsArabic(char c) { return (c >= 0x0600 && c <= 0x06FF) || (c >= 0x0750 && c <= 0x077F) || (c >= 0xFB50 && c <= 0xFDFF) || (c >= 0xFE70 && c <= 0xFEFF); }

    // Text is stored in visual order, so Arabic runs read backwards. Rebuild logical order.
    public static string Logical(string s) {
        if (!s.Any(IsArabic)) return s;
        var parts = new List<string>();
        var cur = new StringBuilder();
        bool? curLtr = null;
        foreach (char c in s) {
            bool strongLtr = char.IsLetterOrDigit(c) && !IsArabic(c);
            bool strongRtl = IsArabic(c);
            bool isLtr = strongLtr || (!strongRtl && curLtr == true && (c == '.' || c == ',' || c == '/' || c == ':' || c == '-' || c == '*'));
            if (curLtr == null || isLtr == curLtr) { cur.Append(c); curLtr = isLtr; }
            else { parts.Add(cur.ToString()); cur.Clear(); cur.Append(c); curLtr = isLtr; }
        }
        if (cur.Length > 0) parts.Add(cur.ToString());
        parts.Reverse();
        var outp = new StringBuilder();
        foreach (var p in parts) {
            bool ltr = p.Any(c => char.IsLetterOrDigit(c) && !IsArabic(c));
            if (ltr) outp.Append(p);
            else { var a = p.ToCharArray(); Array.Reverse(a); outp.Append(new string(a)); }
        }
        string r = outp.ToString();
        try { r = r.Normalize(NormalizationForm.FormKC); } catch { }
        return r;
    }

    public static List<Item> Items(string path) {
        var objs = Load(path);
        var items = new List<Item>();
        var fontMaps = new Dictionary<int, Dictionary<int, string>>();
        int pageNo = 0;
        foreach (int pn in PageObjects(objs)) {
            pageNo++;
            var po = objs[pn];
            var fonts = new Dictionary<string, Dictionary<int, string>>();
            var fd = Regex.Match(po.Dict, @"/Font\s*<<(.*?)>>", RegexOptions.Singleline).Groups[1].Value;
            foreach (Match f in Regex.Matches(fd, @"/(F\d+)\s+(\d+)\s+0\s+R")) {
                int fnum = int.Parse(f.Groups[2].Value);
                if (!fontMaps.ContainsKey(fnum)) {
                    var tu = Regex.Match(objs[fnum].Dict, @"/ToUnicode\s+(\d+)\s+0\s+R");
                    fontMaps[fnum] = tu.Success ? ParseCMap(L1.GetString(Inflate(objs[int.Parse(tu.Groups[1].Value)].Raw))) : new Dictionary<int, string>();
                }
                fonts[f.Groups[1].Value] = fontMaps[fnum];
            }
            int cn = int.Parse(Regex.Match(po.Dict, @"/Contents\s+(\d+)\s+0\s+R").Groups[1].Value);
            string c = L1.GetString(Inflate(objs[cn].Raw));
            ParseContent(c, pageNo, fonts, items);
        }
        return items;
    }

    static void ParseContent(string c, int page, Dictionary<string, Dictionary<int, string>> fonts, List<Item> items) {
        int i = 0, n = c.Length;
        var stack = new List<string>();
        string font = null; double size = 0, x = 0, y = 0, lineX = 0, lineY = 0;
        bool inText = false;
        while (i < n) {
            char ch = c[i];
            if (char.IsWhiteSpace(ch)) { i++; continue; }
            if (ch == '(') {
                var sb = new StringBuilder();
                int depth = 1; i++;
                while (i < n && depth > 0) {
                    char d = c[i];
                    if (d == '\\') {
                        i++;
                        char e = c[i];
                        if (e == 'n') sb.Append('\n'); else if (e == 'r') sb.Append('\r'); else if (e == 't') sb.Append('\t');
                        else if (e == 'b') sb.Append('\b'); else if (e == 'f') sb.Append('\f');
                        else if (e >= '0' && e <= '7') {
                            int v = 0, k = 0;
                            while (k < 3 && i < n && c[i] >= '0' && c[i] <= '7') { v = v * 8 + (c[i] - '0'); i++; k++; }
                            sb.Append((char)v); continue;
                        } else if (e == '\r') { if (c[i + 1] == '\n') i++; }
                        else if (e == '\n') { }
                        else sb.Append(e);
                        i++; continue;
                    }
                    if (d == '(') depth++;
                    else if (d == ')') { depth--; if (depth == 0) { i++; break; } }
                    sb.Append(d); i++;
                }
                stack.Add("S" + sb.ToString());
                continue;
            }
            if (ch == '<' && i + 1 < n && c[i + 1] != '<') {
                int e = c.IndexOf('>', i);
                string hex = c.Substring(i + 1, e - i - 1);
                var sb = new StringBuilder();
                for (int k = 0; k + 1 < hex.Length; k += 2) sb.Append((char)Convert.ToInt32(hex.Substring(k, 2), 16));
                stack.Add("S" + sb.ToString());
                i = e + 1; continue;
            }
            if (ch == '[' || ch == ']') { stack.Add(ch.ToString()); i++; continue; }
            if (ch == '<' || ch == '>') { i += 2; continue; }
            int st = i;
            while (i < n && !char.IsWhiteSpace(c[i]) && c[i] != '(' && c[i] != '[' && c[i] != ']' && c[i] != '<' && c[i] != '>') {
                if (i > st && c[i] == '/') break;
                i++;
            }
            if (i == st) { i++; continue; }
            string tok = c.Substring(st, i - st);
            if (char.IsLetter(tok[0]) || tok[0] == '\'' || tok[0] == '"' || tok[0] == '*') {
                if (tok == "BT") { inText = true; x = y = lineX = lineY = 0; }
                else if (tok == "ET") inText = false;
                else if (inText) {
                    Func<int, double> num = k => double.Parse(stack[stack.Count - k], CultureInfo.InvariantCulture);
                    if (tok == "Tf") { font = stack[stack.Count - 2].Substring(1); size = num(1); }
                    else if (tok == "Tm") { x = lineX = num(2); y = lineY = num(1); }
                    else if (tok == "Td" || tok == "TD") { lineX += num(2); lineY += num(1); x = lineX; y = lineY; }
                    else if (tok == "Tj") { Emit(stack[stack.Count - 1].Substring(1), font, size, x, y, page, fonts, items); }
                    else if (tok == "TJ") {
                        var sb = new StringBuilder();
                        for (int k = stack.LastIndexOf("["); k < stack.Count; k++) if (stack[k].Length > 0 && stack[k][0] == 'S') sb.Append(stack[k].Substring(1));
                        Emit(sb.ToString(), font, size, x, y, page, fonts, items);
                    }
                }
                stack.Clear();
            } else stack.Add(tok);
        }
    }

    static void Emit(string raw, string font, double size, double x, double y, int page, Dictionary<string, Dictionary<int, string>> fonts, List<Item> items) {
        var map = fonts[font];
        var sb = new StringBuilder();
        for (int k = 0; k + 1 < raw.Length; k += 2) {
            int code = (raw[k] << 8) | raw[k + 1];
            string u;
            if (map.TryGetValue(code, out u)) sb.Append(u); else { Unmapped++; sb.Append((char)0xFFFD); }
        }
        items.Add(new Item { Page = page, X = x, Y = y, Size = size, Font = font, Text = sb.ToString() });
    }

    // Column edges taken from the table rules drawn in the PDF.
    static string ColumnOf(double x) {
        if (x < 98.81) return "balance";
        if (x < 157.01) return "debit";
        if (x < 215.63) return "credit";
        if (x < 380.1) return "desc";
        if (x < 508.35) return "type";
        return "date";
    }

    public static List<Row> Rows(List<Item> items) {
        var rows = new List<Row>();
        Row last = null;
        foreach (var pg in items.GroupBy(it => it.Page).OrderBy(g => g.Key)) {
            if (pg.Key == 1) continue;
            var tbl = pg.Where(it => it.Y < 672 && it.Y > 62 && it.Text.Trim().Length > 0).ToList();
            var dates = tbl.Where(it => ColumnOf(it.X) == "date" && Regex.IsMatch(it.Text.Trim(), @"^\d{2}/\d{2}/\d{4}$")).OrderByDescending(it => it.Y).ToList();
            var pageRows = new List<Row>();
            foreach (var d in dates) { var r = new Row { Page = pg.Key, Date = d.Text.Trim(), DateY = d.Y }; pageRows.Add(r); rows.Add(r); }
            foreach (var it in tbl.OrderByDescending(a => Math.Round(a.Y, 1)).ThenBy(a => a.X)) {
                Row target = null;
                foreach (var r in pageRows) if (it.Y <= r.DateY + 4) target = r;
                if (target == null) target = last;
                if (target == null) continue;
                string col = ColumnOf(it.X);
                string txt = it.Text.Trim();
                if (col == "date") { if (txt != target.Date) target.Time = txt; }
                else if (col == "type") target.Type = (target.Type == null ? "" : target.Type + " ") + Logical(txt);
                else if (col == "desc") target.Desc.Add(Logical(txt));
                else if (col == "credit") target.Credit += txt;
                else if (col == "debit") target.Debit += txt;
                else if (col == "balance") target.Balance += txt;
            }
            if (pageRows.Count > 0) last = pageRows[pageRows.Count - 1];
        }
        return rows;
    }

    public static string Tsv(List<Row> rows) {
        var sb = new StringBuilder();
        foreach (var r in rows)
            sb.AppendLine(string.Join("\t", new[] { r.Page.ToString(), r.Date, r.Time, r.Type, r.Credit, r.Debit, r.Balance, string.Join(" | ", r.Desc) }));
        return sb.ToString();
    }

    public static string PageOne(List<Item> items) {
        var sb = new StringBuilder();
        foreach (var it in items.Where(a => a.Page == 1).OrderByDescending(a => Math.Round(a.Y, 0)).ThenBy(a => a.X))
            if (it.Text.Trim().Length > 0 && it.Y > 400) sb.AppendLine(string.Format(CultureInfo.InvariantCulture, "{0:F0},{1:F0}: {2}", it.X, it.Y, it.Text.Trim()));
        return sb.ToString();
    }
}
