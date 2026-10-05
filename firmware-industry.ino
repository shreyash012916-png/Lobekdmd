#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>
const char* WIFI_SSID="YOUR_WIFI"; const char* WIFI_PASS="YOUR_PASSWORD";
WebServer server(80); const int MACHINE_PIN=26; bool machine=false;
void status(){StaticJsonDocument<256>d;d["online"]=true;d["machine"]=machine;d["temperature"]=31.0;d["vibration"]=0.08;d["load"]=42;d["camera"]="";String out;serializeJson(d,out);server.send(200,"application/json",out);}
void machineSet(){StaticJsonDocument<64>d;deserializeJson(d,server.arg("plain"));machine=d["on"]|false;digitalWrite(MACHINE_PIN,machine);server.send(200,"application/json","{\"ok\":true}");}
void stopSet(){machine=false;digitalWrite(MACHINE_PIN,LOW);server.send(200,"application/json","{\"ok\":true}");}
void setup(){pinMode(MACHINE_PIN,OUTPUT);digitalWrite(MACHINE_PIN,LOW);WiFi.begin(WIFI_SSID,WIFI_PASS);while(WiFi.status()!=WL_CONNECTED)delay(250);server.enableCORS(true);server.on("/api/status",HTTP_GET,status);server.on("/api/machine",HTTP_POST,machineSet);server.on("/api/stop",HTTP_POST,stopSet);server.begin();}
void loop(){server.handleClient();}
