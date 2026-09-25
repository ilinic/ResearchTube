param(
    [Parameter(Mandatory = $true)][ValidateSet("list-voices", "speak")][string]$Action,
    [string]$TextBase64,
    [string]$VoiceIdBase64
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$SpeechSynthesizerType = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$MediaPlayerType = [Windows.Media.Playback.MediaPlayer, Windows.Media.Playback, ContentType = WindowsRuntime]
$MediaSourceType = [Windows.Media.Core.MediaSource, Windows.Media.Core, ContentType = WindowsRuntime]

function Decode-Utf8Base64([string]$value) {
    if ([string]::IsNullOrEmpty($value)) { return "" }
    return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))
}

function Await-WinRt($operation) {
    return [System.WindowsRuntimeSystemExtensions]::AsTask($operation).GetAwaiter().GetResult()
}

function Write-Event([string]$event, [int]$completed = 0, [int]$total = 0) {
    @{ event = $event; completedChunks = $completed; totalChunks = $total } | ConvertTo-Json -Compress
    [Console]::Out.Flush()
}

function Split-SpeechText([string]$text) {
    $maximum = 1200
    $chunks = New-Object System.Collections.Generic.List[string]
    $remaining = $text.Trim()
    while ($remaining.Length -gt $maximum) {
        $cut = $remaining.LastIndexOfAny([char[]]".`!`?;:`n", $maximum - 1)
        if ($cut -lt [int]($maximum * 0.55)) { $cut = $remaining.LastIndexOf(" ", $maximum - 1) }
        if ($cut -lt 1) { $cut = $maximum }
        $chunks.Add($remaining.Substring(0, $cut + 1).Trim())
        $remaining = $remaining.Substring($cut + 1).Trim()
    }
    if ($remaining.Length -gt 0) { $chunks.Add($remaining) }
    return $chunks
}

if ($Action -eq "list-voices") {
    $synthesizer = [Activator]::CreateInstance($SpeechSynthesizerType)
    try {
        $defaultVoiceId = $synthesizer.Voice.Id
        $voices = @($SpeechSynthesizerType::AllVoices | ForEach-Object {
            @{
                voiceId = $_.Id
                name = $_.DisplayName
                language = $_.Language
                gender = $_.Gender.ToString().ToLowerInvariant()
                isDefault = ($_.Id -eq $defaultVoiceId)
            }
        })
        @{ voices = $voices } | ConvertTo-Json -Compress -Depth 3
    }
    finally {
        if ($null -ne $synthesizer) { $synthesizer.Dispose() }
    }
    exit 0
}

if ($TextBase64 -eq "__STDIN__") { $TextBase64 = [Console]::In.ReadToEnd() }
$text = Decode-Utf8Base64 $TextBase64
$voiceId = Decode-Utf8Base64 $VoiceIdBase64
if ([string]::IsNullOrWhiteSpace($text)) { throw "Text is required." }

$synthesizer = [Activator]::CreateInstance($SpeechSynthesizerType)
$player = [Activator]::CreateInstance($MediaPlayerType)
try {
    if (-not [string]::IsNullOrWhiteSpace($voiceId)) {
        $voice = $SpeechSynthesizerType::AllVoices | Where-Object { $_.Id -eq $voiceId } | Select-Object -First 1
        if ($null -eq $voice) { throw "VOICE_NOT_FOUND" }
        $synthesizer.Voice = $voice
    }
    $chunks = @(Split-SpeechText $text)
    $total = $chunks.Count
    for ($index = 0; $index -lt $total; $index++) {
        Write-Event "synthesizing" $index $total
        $stream = Await-WinRt ($synthesizer.SynthesizeTextToStreamAsync($chunks[$index]))
        try {
            $player.Source = $MediaSourceType::CreateFromStream($stream, $stream.ContentType)
            Write-Event "speaking" $index $total
            $player.Play()
            while ($player.PlaybackSession.PlaybackState.ToString() -ne "None") {
                Start-Sleep -Milliseconds 80
            }
        }
        finally {
            if ($null -ne $stream) { $stream.Dispose() }
        }
        Write-Event "chunkCompleted" ($index + 1) $total
    }
    Write-Event "completed" $total $total
}
finally {
    if ($null -ne $player) { $player.Pause(); $player.Dispose() }
    if ($null -ne $synthesizer) { $synthesizer.Dispose() }
}
