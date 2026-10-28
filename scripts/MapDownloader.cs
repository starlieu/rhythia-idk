using System;
using System.Collections.Generic;
using System.Text.Json;
using Godot;

/// <summary>
/// Downloads maps directly from rhythia.com/maps into the user's maps folder.
/// Accepts a map id or a full rhythia.com/maps URL.
/// Also fetches the searchable map list to power an in-game browser UI.
/// </summary>
public partial class MapDownloader : Node
{
    private const string BaseUrl = "https://rhythia.com";

    public static MapDownloader Instance { get; private set; }

    public event Action<string> DownloadStarted;
    public event Action<string, string> DownloadFinished; // (mapId, filePath)
    public event Action<string> DownloadFailed; // (error)

    public override void _Ready()
    {
        Instance = this;
    }

    private static string MapsDir =>
        System.IO.Path.Combine(OS.GetUserDataDir(), "maps");

    /// <summary>
    /// Fetches the list of maps (id, title, artist, mapper) for the browser UI.
    /// </summary>
    public void FetchMapList(Action<List<Dictionary<string, object>>> onResult, Action<string> onError)
    {
        var http = new HttpRequest();
        AddChild(http);
        http.RequestCompleted += (result, code, _headers, body) =>
        {
            if (result != HttpRequest.ResultCode.Success || code != 200)
            {
                onError?.Invoke($"HTTP error {code}");
                http.QueueFree();
                return;
            }
            try
            {
                var json = JsonDocument.Parse(body.GetStringFromUtf8());
                var list = new List<Dictionary<string, object>>();
                foreach (var el in json.RootElement.EnumerateArray())
                {
                    var entry = new Dictionary<string, object>();
                    foreach (var p in el.EnumerateObject())
                        entry[p.Name] = p.Value.ValueKind switch
                        {
                            JsonValueKind.Number => p.Value.GetDouble(),
                            JsonValueKind.True => true,
                            JsonValueKind.False => false,
                            _ => p.Value.ToString()
                        };
                    list.Add(entry);
                }
                onResult?.Invoke(list);
            }
            catch (Exception e)
            {
                onError?.Invoke(e.Message);
            }
            http.QueueFree();
        };
        http.Request($"{BaseUrl}/maps");
    }

    /// <summary>
    /// Downloads a map file and saves it into user://maps.
    /// Accepts a map id or a full rhythia.com/maps URL.
    /// </summary>
    public void DownloadMap(string mapIdOrUrl, Action<string> onDone = null)
    {
        string id = mapIdOrUrl;
        if (id.StartsWith(BaseUrl))
            id = id.Substring(BaseUrl.Length).TrimStart('/').Replace("maps/", "");

        var http = new HttpRequest();
        AddChild(http);
        DownloadStarted?.Invoke(id);

        http.RequestCompleted += (result, code, _headers, body) =>
        {
            if (result != HttpRequest.ResultCode.Success || code != 200)
            {
                DownloadFailed?.Invoke($"Failed to download map {id}: HTTP {code}");
                http.QueueFree();
                return;
            }

            DirAccess.MakeDirRecursiveAbsolute(MapsDir);
            string fileName = $"{id}.sspm";
            string path = System.IO.Path.Combine(MapsDir, fileName);

            System.IO.File.WriteAllBytes(path, body);
            GD.Print($"[MapDownloader] Saved map to {path}");
            DownloadFinished?.Invoke(id, path);
            onDone?.Invoke(path);
            http.QueueFree();
        };

        http.Request($"{BaseUrl}/maps/{id}");
    }
}
