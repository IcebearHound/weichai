public string FormatPrice(decimal price, string currency)
{
    var culture = System.Threading.Thread.CurrentThread.CurrentCulture;
    var formatter = (System.Globalization.NumberFormatInfo)culture.NumberFormat.Clone();
    formatter.CurrencySymbol = "";
    string formatted;
    try
    {
        var region = new System.Globalization.RegionInfo(culture.Name);
        formatter.CurrencySymbol = region.CurrencySymbol;
    }
    catch
    {
        formatter.CurrencySymbol = currency;
    }
    formatted = price.ToString("C", formatter);
    if (price < 0)
    {
        formatted = "-" + Math.Abs(price).ToString("C", formatter);
    }
    return formatted;
}