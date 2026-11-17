; installer.nsh —— 安装完成后把兼容启动器复制到安装目录
!macro customInstall
  DetailPrint "复制兼容启动器（部分机器需要 --no-sandbox 参数启动）"
  CopyFiles "$INSTDIR\resources\launcher.cmd" "$INSTDIR\启动云栖盘.cmd"
!macroend
