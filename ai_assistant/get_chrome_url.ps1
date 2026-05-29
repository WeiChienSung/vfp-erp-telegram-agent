Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Chrome_WidgetWin_1')
$chromeElements = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)

foreach ($chrome in $chromeElements) {
    # Find edit boxes (address bar is usually the first edit box or has a specific AutomationId/Name)
    $editCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
    $edits = $chrome.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCondition)
    
    foreach ($edit in $edits) {
        try {
            $valPattern = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            if ($valPattern) {
                $url = $valPattern.Current.Value
                if ($url -and ($url.Contains("github.com") -or $url.StartsWith("http"))) {
                    Write-Output "URL_FOUND: $url"
                }
            }
        } catch {}
    }
}
