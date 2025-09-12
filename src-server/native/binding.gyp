{
  "targets": [
    {
      "target_name": "scrcpy_native",
      "sources": [ "scrcpy_native.cc" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ]
    }
  ]
}